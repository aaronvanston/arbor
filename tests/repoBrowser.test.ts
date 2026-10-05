import { describe, expect, it } from 'bun:test';
import {
  baseName,
  firstFile,
  homePath,
  isSkillName,
  newPathProblem,
  projectOf,
  settled,
  skillFolder,
  skillOf,
  skillTemplate,
  standings,
  suggestedMessage,
  treeStatus,
  uncommittedEntries,
} from '../src/services/repoBrowser';
import { syncKind } from '../src/services/setupSync';
import type { RepoEntry, SetupHome, SetupItem, SetupMachine, SetupRepo, SetupRepoFile } from '../src/native/types';
import { itemAt } from './support/items';

const entry = (path: string, fields: Partial<RepoEntry> = {}): RepoEntry => ({ path, role: 'other', status: 'same', size: 120, problem: null, ...fields });

const item = (path: string, sum: string): SetupItem => ({
  kind: 'instructions', name: baseName(path), path, sum, size: 120, link: null, value: null, note: null, count: null, enabled: null,
  text: true, skill: null, import: null,
});
const home = (items: SetupItem[]): SetupHome => ({ agent: 'claude', path: '~/.claude', items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null });
const machine = (name: string, homes: SetupHome[], scannedAt: number | null = 1_000): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt, error: null, scanning: false,
});
const repoFile = (path: string, sum: string): SetupRepoFile => ({ path, kind: syncKind(path)!, sum, ck: 'c1-120', size: 120 });
const repo = (files: SetupRepoFile[], head = true): SetupRepo => ({
  path: '/Users/cam/src/agent-setup', branch: 'main', head: head ? { sha: 'ab'.repeat(20), subject: 'Start', atMs: 1_000 } : null,
  upstream: null, uncommitted: [], files, skills: [], ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], offSkills: [], offFiles: [], fileMachines: {},
  skillProjects: {}, mcpProjects: {}, instructions: [], plugins: [], codexPlugins: [],
});

describe('what a path in the repo is', () => {
  it('finds the skill a file is in, and only under the skills folder', () => {
    expect(skillOf('.agents/skills/pdf/SKILL.md')).toBe('pdf');
    expect(skillOf('.agents/skills/pdf')).toBe('pdf');
    expect(skillOf('.agents/skills/')).toBeNull();
    expect(skillOf('.claude/skills/pdf/SKILL.md')).toBeNull();
    expect(skillFolder('pdf')).toBe('.agents/skills/pdf');
  });

  it('reads a project’s own instructions for every machine or one, and nothing else under projects', () => {
    expect(projectOf('.agents/projects/cam/arbor/instructions.md')).toEqual({ project: 'cam/arbor', machine: null });
    expect(projectOf('.agents/projects/cam/arbor/machines/ci01.md')).toEqual({ project: 'cam/arbor', machine: 'ci01' });
    expect(projectOf('.agents/projects/cam/arbor/notes.md')).toBeNull();
    expect(projectOf('.agents/projects/cam/arbor/machines/.md')).toBeNull();
    expect(projectOf('.agents/projects/cam')).toBeNull();
  });

  it('says where a synced file or skill goes on each machine, and nothing for the rest', () => {
    expect(homePath({ path: '.claude/CLAUDE.md', role: 'instructions' })).toBe('~/.claude/CLAUDE.md');
    expect(homePath({ path: '.agents/hooks/guard.sh', role: 'hookScript' })).toBe('~/.agents/hooks/guard.sh');
    expect(homePath({ path: '.agents/skills/pdf/scripts/run.py', role: 'skill' })).toBe('~/.agents/skills/pdf');
    expect(homePath({ path: '.agents/machines.json', role: 'record' })).toBeNull();
    expect(homePath({ path: '.agents/projects/cam/arbor/instructions.md', role: 'projectInstructions' })).toBeNull();
    expect(homePath({ path: 'README.md', role: 'other' })).toBeNull();
  });
});

describe('the tree', () => {
  const entries = [
    entry('.claude/CLAUDE.md', { role: 'instructions', status: 'modified' }),
    entry('.claude/rules/old.md', { role: 'rule', status: 'deleted' }),
    entry('.claude/rules/new.md', { role: 'rule', status: 'added' }),
    entry('.agents/skills/pdf/.env', { role: 'skill', problem: 'secret' }),
    entry('README.md'),
  ];

  it('colors only what isn’t committed, as git does', () => {
    expect(treeStatus(entries)).toEqual([
      { path: '.claude/CLAUDE.md', status: 'modified' },
      { path: '.claude/rules/old.md', status: 'deleted' },
      { path: '.claude/rules/new.md', status: 'added' },
    ]);
    expect(uncommittedEntries(entries).map((found) => found.path)).toEqual(['.claude/CLAUDE.md', '.claude/rules/old.md', '.claude/rules/new.md']);
  });

  it('opens the README first, then Claude Code’s instructions, never a file it can’t show or one that’s gone', () => {
    expect(firstFile(entries)).toBe('README.md');
    expect(firstFile(entries.filter((found) => found.path !== 'README.md'))).toBe('.claude/CLAUDE.md');
    expect(firstFile([entry('.claude/rules/old.md', { status: 'deleted' }), entry('a/.env', { problem: 'secret' }), entry('b.md')])).toBe('b.md');
    expect(firstFile([entry('a/.env', { problem: 'secret' })])).toBeNull();
  });
});

describe('how each machine’s copy stands', () => {
  const files = [repoFile('~/.claude/CLAUDE.md', 'aaa')];
  const same = machine('cam-mbp', [home([item('~/.claude/CLAUDE.md', 'aaa')])]);
  const different = machine('ci-01', [home([item('~/.claude/CLAUDE.md', 'bbb')])]);
  const unread = machine('cedar-02', [], null);

  it('compares the machines that have been scanned with the last commit', () => {
    const list = standings(repo(files), [same, different, unread], { path: '.claude/CLAUDE.md', role: 'instructions' });
    expect(list.map((standing) => [standing.machine, standing.state])).toEqual([['cam-mbp', 'same'], ['ci-01', 'update'], ['cedar-02', 'unread']]);
    expect(settled(itemAt(list, 0).state)).toBe(true);
    expect(settled(itemAt(list, 1).state)).toBe(false);
  });

  it('has nothing to say about a file no machine gets, or before the first commit', () => {
    expect(standings(repo(files), [same], { path: 'README.md', role: 'other' })).toEqual([]);
    expect(standings(repo(files, false), [same], { path: '.claude/CLAUDE.md', role: 'instructions' })).toEqual([]);
  });
});

describe('new paths', () => {
  const entries = [entry('.claude/CLAUDE.md'), entry('.agents/skills/pdf/SKILL.md')];

  it('takes a path inside the folder that nothing has yet', () => {
    expect(newPathProblem('.claude/rules/naming.md', entries)).toBeNull();
    expect(newPathProblem('', entries)).toBe('repo.new.problem.empty');
    expect(newPathProblem('  ', entries)).toBe('repo.new.problem.empty');
    for (const outside of ['/etc/hosts', '../x.md', 'a//b.md', './a.md', 'a\\b.md', '.claude/']) {
      expect(newPathProblem(outside, entries)).toBe('repo.new.problem.outside');
    }
    expect(newPathProblem('.git/config', entries)).toBe('repo.new.problem.git');
    expect(newPathProblem('vendor/.GIT/HEAD', entries)).toBe('repo.new.problem.git');
    expect(newPathProblem('.claude/CLAUDE.md', entries)).toBe('repo.new.problem.taken');
    expect(newPathProblem('.agents/skills/pdf', entries)).toBe('repo.new.problem.taken');
    expect(newPathProblem('.claude/CLAUDE.md/notes.md', entries)).toBe('repo.new.problem.taken');
  });

  it('never makes a file whose name says it may hold a secret, as the backend reads one', () => {
    for (const secret of ['.env', '.env.local', 'id_rsa', 'id_ed25519.pub', 'auth.json', '.netrc', 'server.pem', 'tls.key', 'cert.p12', 'api-token.md', 'my-credentials', 'secrets/x.md']) {
      expect(newPathProblem(`.agents/skills/pdf/${secret}`, entries)).toBe('repo.new.problem.secret');
    }
    expect(newPathProblem('.agents/skills/pdf/keyboard.md', entries)).toBeNull();
  });

  it('names a skill as the store takes one, and starts its SKILL.md with what agents read', () => {
    expect(isSkillName('release-check')).toBe(true);
    expect(isSkillName('pdf_2.1')).toBe(true);
    expect(isSkillName('.hidden')).toBe(false);
    expect(isSkillName('a/b')).toBe(false);
    expect(isSkillName('')).toBe(false);
    expect(skillTemplate('release-check')).toBe('---\nname: release-check\ndescription: \n---\n\n# release-check\n');
  });
});

describe('commit messages', () => {
  it('suggests one from what changed', () => {
    expect(suggestedMessage([])).toBeNull();
    expect(suggestedMessage([{ path: '.claude/CLAUDE.md', status: 'modified' }])).toEqual({ key: 'repo.commit.suggest.edit', name: 'CLAUDE.md' });
    expect(suggestedMessage([{ path: '.claude/rules/new.md', status: 'added' }])).toEqual({ key: 'repo.commit.suggest.add', name: 'new.md' });
    expect(suggestedMessage([{ path: '.claude/rules/old.md', status: 'deleted' }])).toEqual({ key: 'repo.commit.suggest.delete', name: 'old.md' });
    expect(suggestedMessage([
      { path: '.agents/skills/pdf/SKILL.md', status: 'modified' },
      { path: '.agents/skills/pdf/notes.md', status: 'added' },
    ])).toEqual({ key: 'repo.commit.suggest.skill', name: 'pdf' });
    expect(suggestedMessage([
      { path: '.agents/skills/pdf/SKILL.md', status: 'modified' },
      { path: '.claude/CLAUDE.md', status: 'modified' },
    ])).toEqual({ key: 'repo.commit.suggest.many', count: 2 });
  });
});

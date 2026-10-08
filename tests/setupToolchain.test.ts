import { describe, expect, it } from 'bun:test';
import {
  buildLibraries,
  buildToolchainProjects,
  buildToolRows,
  checkNeed,
  compareVersions,
  installableNode,
  libraryProblems,
  matchesPin,
  matchesToolchain,
  needsLook,
  needsScan,
  needTest,
  nodeInstallers,
  nodeVersions,
  notInstalled,
  olderNodeVersions,
  placeSummary,
  projectsAsking,
  releaseLine,
  satisfiesPython,
  satisfiesRange,
  TOOLCHAIN_FRESH_MS,
} from '../src/services/setupToolchain';
import { itemAt, present } from './support/items';
import type {
  KeptVersion,
  MachineToolchain,
  NeedKind,
  ProjectLibrary,
  ProjectToolchain,
  ToolFound,
  ToolNeed,
} from '../src/native/types';

const NOW = Date.parse('2026-09-25T12:00:00Z');

const need = (tool: string, wants: string, kind: NeedKind = 'range', fields: Partial<ToolNeed> = {}): ToolNeed => ({ tool, wants, kind, file: 'package.json', field: null, ...fields });
const tool = (name: string, version: string | null, path = `/usr/local/bin/${name}`): ToolFound => ({ tool: name, path, version });
const kept = (name: string, manager: string, version: string, label: string | null = null): KeptVersion => ({ tool: name, manager, version, label });
const library = (name: string, wants: string, installed: string | null, fields: Partial<ProjectLibrary> = {}): ProjectLibrary => ({ dir: '', name, wants, dev: false, installed, checked: true, ...fields });
const project = (path: string, remote: string | null, fields: Partial<ProjectToolchain> = {}): ProjectToolchain => ({
  path, missing: false, remote, lastUsedMs: null, needs: [], libraries: [], librariesMore: 0, packages: [], unread: [], ...fields,
});
const machine = (name: string, homeDir: string, fields: Partial<MachineToolchain> = {}): MachineToolchain => ({
  machine: name, homeDir, os: 'Darwin', arch: 'arm64', scannedAt: NOW, partial: false, scanning: false, error: null, tools: [], kept: [], projects: [], ...fields,
});

describe('versions', () => {
  it('orders versions, with a release after its pre-releases', () => {
    expect(compareVersions('22.17.0', '22.9.1')).toBe(1);
    expect(compareVersions('v1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.90.0-nightly', '1.90.0')).toBe(-1);
    expect(compareVersions('3.14.0rc1', '3.14.0rc2')).toBe(-1);
  });

  it('reads npm ranges the way npm does', () => {
    const cases: [string, string, boolean][] = [
      ['22.17.0', '>=22', true],
      ['20.19.0', '>=22', false],
      ['19.1.0', '^19.1.0', true],
      ['20.0.0', '^19.1.0', false],
      ['0.2.9', '^0.2.3', true],
      ['0.3.0', '^0.2.3', false],
      ['0.0.4', '^0.0.3', false],
      ['5.9.9', '~5.9.2', true],
      ['5.10.0', '~5.9.2', false],
      ['22.4.0', '22.x', true],
      ['22.4.0', '22', true],
      ['23.0.0', '22', false],
      ['18.20.0', '^18.18.0 || >=20', true],
      ['19.0.0', '^18.18.0 || >=20', false],
      ['1.5.0', '1.2 - 1.6', true],
      ['1.7.0', '1.2 - 1.6', false],
      ['1.6.9', '1.2.3 - 1.6', true],
      ['2.1.0', '>= 2.0.0 < 3', true],
      ['3.0.0', '>=2 <3', false],
      ['1.2.3', '=1.2.3', true],
      ['1.2.4', '1.2.3', false],
      ['9.9.9', '*', true],
      ['9.9.9', '', true],
      ['1.3.0', '>1.2', true],
      ['1.2.9', '>1.2', false],
      ['1.2.9', '<=1.2', true],
      ['1.3.0', '<=1.2', false],
    ];
    for (const [version, range, fits] of cases) expect([version, range, satisfiesRange(version, range)]).toEqual([version, range, fits]);
    // A pre-release fits only a range that names a pre-release of the same version.
    expect(satisfiesRange('5.0.0-rc.1', '^4.17.0')).toBe(false);
    expect(satisfiesRange('22.0.0-rc.1', '>=22.0.0-rc.0')).toBe(true);
    expect(satisfiesRange('1.0.0', 'lts/iron')).toBeNull();
    expect(satisfiesRange('not a version', '>=1')).toBeNull();
  });

  it('reads Python specifiers, and the npm-style ones Poetry writes', () => {
    expect(satisfiesPython('3.12.4', '>=3.11,<4')).toBe(true);
    expect(satisfiesPython('3.10.0', '>=3.11,<4')).toBe(false);
    expect(satisfiesPython('3.12.9', '~=3.12.1')).toBe(true);
    expect(satisfiesPython('3.13.0', '~=3.12.1')).toBe(false);
    expect(satisfiesPython('3.13.0', '~=3.12')).toBe(true);
    expect(satisfiesPython('3.12.4', '==3.12.*')).toBe(true);
    expect(satisfiesPython('3.13.0', '==3.12.*')).toBe(false);
    expect(satisfiesPython('3.12.4', '!=3.12.4')).toBe(false);
    expect(satisfiesPython('3.12.4', '^3.11')).toBe(true);
    expect(satisfiesPython('3.12.4', '>=3.11; python_version')).toBeNull();
    expect(satisfiesPython('3.13.0rc1', '<3.13')).toBe(false);
    expect(satisfiesPython('3.12.4', '>=3.9,<3.13')).toBe(true);
  });

  it('matches pins on the parts they give', () => {
    expect(matchesPin('22.17.0', '22')).toBe(true);
    expect(matchesPin('22.17.0', 'v22.17')).toBe(true);
    expect(matchesPin('22.17.1', '22.17.0')).toBe(false);
    expect(matchesPin('3.12.4', 'pypy3.10')).toBeNull();
    const stable = present(needTest(need('rust', 'stable', 'pin')));
    expect(stable('1.88.0')).toBe(true);
    expect(stable('1.90.0-nightly')).toBe(false);
    expect(stable('1.85.0', 'stable')).toBe(true);
    const nightly = present(needTest(need('rust', 'nightly-2026-09-01', 'pin')));
    expect(nightly('1.90.0-nightly')).toBe(false);
    expect(nightly('1.90.0-nightly', 'nightly-2026-09-01')).toBe(true);
    const lts = present(needTest(need('node', 'lts/*', 'pin')));
    expect([lts('22.1.0'), lts('23.1.0')]).toEqual([true, false]);
    const iron = present(needTest(need('node', 'lts/iron', 'pin')));
    expect([iron('20.19.0'), iron('22.1.0')]).toEqual([true, false]);
    expect(needTest(need('node', 'lts/unknown', 'pin'))).toBeNull();
    expect(needTest(need('node', 'ref:abc', 'pin'))).toBeNull();
    expect(present(needTest(need('rust', '1.85', 'min')))('1.88.0')).toBe(true);
    expect(present(needTest(need('rust', '1.85', 'min')))('1.85.0-nightly')).toBe(true);
    expect(present(needTest(need('go', '1.23', 'min')))('1.22.9')).toBe(false);
  });
});

describe('what a machine has for what a project asks', () => {
  it('says whether each machine can build a project, and what it would take', () => {
    const mac = machine('mbp', '/Users/cam', {
      tools: [
        tool('node', '22.17.0', '/Users/cam/.nvm/versions/node/v22.17.0/bin/node'),
        tool('python', '3.12.4', '/Users/cam/.local/share/mise/shims/python3'),
        tool('rust', '1.88.0', '/Users/cam/.cargo/bin/rustc'),
        tool('go', '1.24.4'),
        tool('pnpm', '10.2.0'),
        tool('bun', null),
      ],
      kept: [kept('node', 'nvm', '20.19.0'), kept('python', 'mise', '3.11.9'), kept('rust', 'rustup', '1.88.0', 'stable')],
    });
    const state = (wanted: ToolNeed) => checkNeed(wanted, mac).state;
    expect(state(need('node', '>=22'))).toBe('ok');
    expect(state(need('node', '20', 'pin', { file: '.nvmrc' }))).toBe('switch');
    expect(checkNeed(need('node', '20', 'pin'), mac).using).toEqual(kept('node', 'nvm', '20.19.0'));
    expect(state(need('python', '3.11', 'pin', { file: '.python-version' }))).toBe('managed');
    expect(state(need('rust', '1.90.0', 'pin', { file: 'rust-toolchain.toml' }))).toBe('fetch');
    expect(state(need('go', '1.25', 'min'))).toBe('fetch');
    expect(state(need('pnpm', '9.15.0', 'pin', { field: 'packageManager' }))).toBe('fetch');
    expect(state(need('node', '18', 'pin'))).toBe('differs');
    expect(state(need('node', '>=24'))).toBe('mismatch');
    expect(state(need('deno', '*'))).toBe('missing');
    expect(state(need('bun', '*'))).toBe('unknown');
    expect(state(need('node', 'lts/iron', 'range'))).toBe('unknown');
    // When nvm and mise both keep a fitting version, mise's shim is the one that picks it.
    const both = machine('m', '/Users/cam', {
      tools: [tool('node', '22.17.0', '/Users/cam/.local/share/mise/shims/node')],
      kept: [kept('node', 'nvm', '20.19.0'), kept('node', 'mise', '20.19.0')],
    });
    expect(checkNeed(need('node', '20.19.0', 'pin', { file: '.tool-versions' }), both)).toMatchObject({ state: 'managed', using: { manager: 'mise' } });
    // uv picks the Python a uv project pins, and fetches it when it isn't there.
    const uvMachine = machine('ci', '/home/ci', { tools: [tool('python', '3.10.0'), tool('uv', '0.8.0')], kept: [kept('python', 'uv', '3.13.5')] });
    const uvProject = project('/home/ci/app', null, { needs: [need('uv', '*', 'range', { file: 'uv.lock' })] });
    expect(checkNeed(need('python', '3.13', 'pin'), uvMachine, uvProject).state).toBe('managed');
    expect(checkNeed(need('python', '3.14', 'pin'), uvMachine, uvProject).state).toBe('fetch');
    expect(checkNeed(need('python', '3.14', 'pin'), uvMachine).state).toBe('differs');
  });

  it('finds packages installed at versions package.json doesn’t ask for', () => {
    const app = project('/src/app', null, {
      packages: [{ dir: '', lockfile: 'bun.lock', modules: true }, { dir: 'web', lockfile: null, modules: false }],
      libraries: [library('react', '^19.1.0', '19.0.0'), library('zod', '^4', null), library('vite', '^7', '7.1.2'), library('next', '^15', null, { dir: 'web' })],
    });
    expect(libraryProblems(app).map(({ library: entry, problem }) => [entry.name, problem])).toEqual([['react', 'unmatched'], ['zod', 'absent']]);
    // A package the scan didn't get to isn't called missing.
    const cut = project('/src/app', null, { packages: [{ dir: '', lockfile: null, modules: true }], libraries: [library('react', '^19', '19.1.0'), library('zod', '^4', null, { checked: false })] });
    expect(libraryProblems(cut)).toEqual([]);
    // A folder next to an installed one, with none of its own packages found, isn't installed rather than missing each.
    const docs = project('/src/app', null, {
      packages: [{ dir: '', lockfile: null, modules: true }, { dir: 'docs', lockfile: null, modules: true }],
      libraries: [library('react', '^19', '19.1.0'), library('vitepress', '^1', null, { dir: 'docs' }), library('vue', '^3', null, { dir: 'docs' })],
    });
    expect(libraryProblems(docs)).toEqual([]);
    expect(notInstalled(docs).map((entry) => entry.dir)).toEqual(['docs']);
  });
});

describe('rows', () => {
  const mbp = machine('mbp', '/Users/cam', {
    tools: [tool('node', '22.17.0'), tool('git', '2.50.1'), tool('bun', '1.3.2')],
    kept: [kept('node', 'nvm', '20.19.0'), kept('node', 'nvm', '24.3.0')],
    projects: [
      project('/Users/cam/src/arbor', 'github.com/cam/arbor', {
        lastUsedMs: NOW - 1_000,
        needs: [need('node', '>=22'), need('bun', '*', 'range', { file: 'bun.lock' })],
        packages: [{ dir: '', lockfile: 'bun.lock', modules: true }],
        libraries: [library('react', '^19.1.0', '19.1.1'), library('vite', '^7', '7.1.2', { dev: true })],
      }),
      project('/Users/cam/src/site', 'github.com/cam/site', {
        lastUsedMs: NOW - 9_000,
        libraries: [library('react', '^18.3.0', '18.3.1'), library('vite', '^7', null, { dev: true })],
      }),
    ],
  });
  const ci = machine('ci', '/home/ci', {
    tools: [tool('node', '20.19.0'), tool('git', '2.43.0')],
    projects: [
      project('/home/ci/src/arbor', 'github.com/cam/arbor', {
        lastUsedMs: NOW - 5_000,
        needs: [need('node', '>=22'), need('bun', '*', 'range', { file: 'bun.lock' })],
        packages: [{ dir: '', lockfile: 'bun.lock', modules: true }],
        libraries: [library('react', '^19.1.0', '19.1.0'), library('vite', '^7', '7.1.2', { dev: true })],
      }),
    ],
  });

  it('lines tools up across machines and marks the ones a release behind', () => {
    const rows = buildToolRows([mbp, ci, machine('new', '/home/new', { scannedAt: null })]);
    expect(rows.map((row) => row.tool)).toEqual(['node', 'bun', 'git']);
    const node = itemAt(rows, 0);
    expect(node.newest).toBe('22.17.0');
    expect(present(node.cells.ci).behind).toBe(true);
    expect(present(node.cells.mbp).kept.map((entry) => entry.version)).toEqual(['24.3.0', '20.19.0']);
    expect(Object.keys(node.cells)).toEqual(['mbp', 'ci']);
    expect(present(itemAt(rows, 2).cells.ci).behind).toBe(true);
    expect(itemAt(rows, 1).differs).toBe(true);
    expect([node.anyBehind, itemAt(rows, 1).anyBehind]).toEqual([true, false]);
  });

  it('groups each project’s copies and says what stands in the way on each machine', () => {
    const rows = buildToolchainProjects([mbp, ci]);
    expect(rows.map((row) => row.name)).toEqual(['arbor', 'site']);
    const arbor = itemAt(rows, 0);
    expect(arbor.state).toBe('missing');
    expect(needsLook(arbor)).toBe(true);
    expect(arbor.drift).toEqual([{ dir: '', name: 'react', versions: { mbp: '19.1.1', ci: '19.1.0' } }]);
    const onCi = placeSummary(present(arbor.places.ci));
    expect(onCi.state).toBe('missing');
    expect(onCi.worst?.need.tool).toBe('bun');
    expect(onCi.more).toBe(1);
    expect(placeSummary(present(arbor.places.mbp)).worst).toBeNull();
    expect(needsLook(itemAt(rows, 1))).toBe(false);
    expect(matchesToolchain(arbor, 'BUN')).toBe(true);
    expect(matchesToolchain(arbor, '/home/ci/src')).toBe(true);
    expect(matchesToolchain(arbor, 'django')).toBe(false);
  });

  it('names the projects on a machine that ask for a tool, for removing it there', () => {
    const rows = buildToolchainProjects([mbp, ci]);
    expect(projectsAsking(rows, 'ci', 'bun')).toEqual(['arbor']);
    expect(projectsAsking(rows, 'ci', 'deno')).toEqual([]);
    expect(projectsAsking(rows, 'nowhere', 'bun')).toEqual([]);
  });

  it('shows which release of a shared library each project is on', () => {
    const libraries = buildLibraries(buildToolchainProjects([mbp, ci]));
    expect(libraries.map((row) => [row.name, row.lines])).toEqual([['react', 2], ['vite', 1]]);
    const react = itemAt(libraries, 0);
    expect(react.uses.map((use) => [use.name, use.version, use.installed])).toEqual([['arbor', '19.1.1', true], ['site', '18.3.1', true]]);
    expect(itemAt(libraries, 1).uses.map((use) => [use.name, use.version, use.installed, use.dev])).toEqual([['arbor', '7.1.2', true, true], ['site', '^7', false, true]]);
    expect([releaseLine('0.4.2'), releaseLine('^19.1.0'), releaseLine('latest')]).toEqual(['0.4', '19', null]);
  });

  it('scans a machine again only when it hasn’t been lately', () => {
    expect(needsScan(undefined, NOW)).toBe(true);
    expect(needsScan(machine('a', '', { scannedAt: NOW - 60_000 }), NOW)).toBe(false);
    expect(needsScan(machine('a', '', { scannedAt: NOW - TOOLCHAIN_FRESH_MS - 1 }), NOW)).toBe(true);
    expect(needsScan(machine('a', '', { scannedAt: null, scanning: true }), NOW)).toBe(false);
  });
});

describe('Node’s versions on a machine', () => {
  const cedar = machine('cedar', '/Users/a', {
    tools: [tool('node', '22.17.0', '/Users/a/.nvm/versions/node/v22.17.0/bin/node')],
    kept: [kept('node', 'nvm', 'v20.19.0'), kept('node', 'nvm', 'v22.17.0'), kept('node', 'brew', '24.1.0'), kept('python', 'mise', '3.12.4')],
    projects: [
      project('/Users/a/src/arbor', 'github.com/a/arbor', { needs: [need('node', '20', 'pin', { file: '.nvmrc' })] }),
      project('/Users/a/src/site', 'github.com/a/site', { needs: [need('node', '>=18')] }),
    ],
  });

  it('lists each kept version newest first, the default and the projects that pin it', () => {
    const versions = nodeVersions(cedar);
    expect(versions.map((entry) => [entry.kept.version, entry.isDefault, entry.pinnedBy, entry.canRemove, entry.canDefault])).toEqual([
      // Homebrew's Node isn't a version manager's, so Arbor leaves it alone.
      ['24.1.0', false, [], false, false],
      ['v22.17.0', true, [], false, false],
      // A range isn't a pin: only .nvmrc-style pins send a project looking for the version.
      ['v20.19.0', false, ['arbor'], true, true],
    ]);
  });

  it('knows the default behind a shim by the version node gave', () => {
    const shimmed = machine('ci', '/home/a', { tools: [tool('node', '22.12.0', '/home/a/.local/share/mise/shims/node')], kept: [kept('node', 'mise', '22.12.0'), kept('node', 'mise', '20.18.1')] });
    expect(nodeVersions(shimmed).map((entry) => entry.isDefault)).toEqual([true, false]);
  });

  it('installs with the version managers the machine has', () => {
    expect(nodeInstallers(cedar)).toEqual(['nvm']);
    expect(nodeInstallers(machine('v', '/h', { tools: [tool('node', '20.1.0', '/h/.volta/bin/node')] }))).toEqual(['volta']);
    expect(nodeInstallers(machine('none', '/h'))).toEqual([]);
    expect(['22', 'v22.20.0', '22.20', ' 24 '].map(installableNode)).toEqual([true, true, true, true]);
    expect(['lts/*', '22.x', '22; rm', ''].map(installableNode)).toEqual([false, false, false, false]);
  });

  it('picks for a cleanup the older patches of each line, never the default, a pin or a line’s newest', () => {
    const crowded = machine('oak', '/Users/o', {
      tools: [tool('node', '20.19.4', '/Users/e/.nvm/versions/node/v20.19.4/bin/node')],
      kept: [
        kept('node', 'fnm', '24.12.0'), kept('node', 'nvm', '22.21.1'), kept('node', 'fnm', '22.18.0'),
        kept('node', 'nvm', '22.13.1'), kept('node', 'fnm', '22.13.1'), kept('node', 'nvm', '20.19.4'),
        kept('node', 'nvm', '20.15.1'), kept('node', 'nvm', '20.12.2'), kept('node', 'nvm', '19.8.1'),
        kept('node', 'volta', '18.20.4'), kept('node', 'nvm', '18.15.0'), kept('node', 'nvm', '18.10.0'),
      ],
      projects: [project('/Users/e/src/old', null, { needs: [need('node', '20.12.2', 'pin', { file: '.nvmrc' })] })],
    });
    expect(olderNodeVersions(nodeVersions(crowded)).map((entry) => `${entry.kept.manager}:${entry.kept.version}`)).toEqual([
      // 20.19.4 is the default and 20.12.2 is pinned; Volta's 18.20.4 can't be removed but is still 18's newest.
      'fnm:22.18.0', 'nvm:22.13.1', 'fnm:22.13.1', 'nvm:20.15.1', 'nvm:18.15.0', 'nvm:18.10.0',
    ]);
  });
});

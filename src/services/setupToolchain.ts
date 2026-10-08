import { invokeCommand } from '../native/commands';
import { projectKey, projectName } from './setupProjects';
import { tracked } from './productAnalytics';
import type {
  KeptVersion,
  MachineToolchain,
  NodeChange,
  PackageDir,
  ProjectLibrary,
  ProjectToolchain,
  ToolFound,
  ToolNeed,
} from '../native/types';

/**
 * The tools a shell on each machine finds first, the other versions its version managers keep, and what each repo
 * sessions have worked in there asks for. A scan only reads.
 */

export const SETUP_TOOLCHAIN_UPDATED_EVENT = 'setup-toolchain-updated';
/** A scan older than this is run again when the tab opens; tools change far less often than checkouts. */
export const TOOLCHAIN_FRESH_MS = 60 * 60_000;
/** The tools in the order the page lists them. */
export const TOOL_ORDER = ['node', 'npm', 'pnpm', 'yarn', 'bun', 'deno', 'python', 'uv', 'go', 'rust', 'cargo', 'git', 'gh', 'jq', 'rg', 'docker'] as const;
export type ToolId = (typeof TOOL_ORDER)[number];

export const getToolchain = () => invokeCommand('get_toolchain');
export const scanToolchain = (machine: string) => invokeCommand('scan_toolchain', { machine });

export function needsScan(toolchain: MachineToolchain | undefined, now: number): boolean {
  if (!toolchain) return true;
  if (toolchain.scanning) return false;
  return toolchain.scannedAt === null || now - toolchain.scannedAt > TOOLCHAIN_FRESH_MS;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

type Version = { nums: number[]; pre: string };

/** `22.17.0`, `v22`, `1.90.0-nightly` or `3.14.0rc1`, as numbers and a pre-release tag. */
export function parseVersion(text: string): Version | null {
  const match = /^\s*[v=]?\s*(\d+(?:\.\d+)*)(?:-?([0-9A-Za-z][0-9A-Za-z.-]*))?(?:\+\S*)?\s*$/.exec(text);
  const [, numbers, pre] = match ?? [];
  if (!numbers) return null;
  return { nums: numbers.split('.').map(Number), pre: pre ?? '' };
}

/** Which of two versions is newer: a release comes after its pre-releases. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a.localeCompare(b);
  return compareParsed(left, right);
}

function compareParsed(left: Version, right: Version): number {
  for (let index = 0; index < Math.max(left.nums.length, right.nums.length); index += 1) {
    const difference = (left.nums[index] ?? 0) - (right.nums[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, 'en', { numeric: true });
}

const at = (nums: number[], index: number) => nums[index] ?? 0;
type Comparator = { op: '<' | '<=' | '>' | '>=' | '='; nums: number[]; pre: string };
const WILD = /^(?:\*|x|X)$/;

/** The comparators one npm range (no `||`) comes to, or null when Arbor doesn't read it. */
function comparators(text: string): Comparator[] | null {
  const range = text.trim();
  if (!range || WILD.test(range)) return [];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(range);
  if (hyphen) {
    const [, low = '', high = ''] = hyphen;
    const from = partial(low);
    const to = partial(high);
    if (!from || !to) return null;
    const upper: Comparator = to.parts.length >= 3 || to.parts.length === 0
      ? { op: '<=', nums: fill(to.parts), pre: to.pre }
      : { op: '<', nums: bump(to.parts), pre: '' };
    return [{ op: '>=', nums: fill(from.parts), pre: from.pre }, ...(to.parts.length ? [upper] : [])];
  }
  const tokens = range.replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1').split(/\s+/);
  const out: Comparator[] = [];
  for (const token of tokens) {
    const match = /^(>=|<=|>|<|=|\^|~>?|)(.*)$/.exec(token);
    const [, op = '', rest = ''] = match ?? [];
    const version = partial(rest);
    if (!version) return null;
    const { parts, pre } = version;
    const [major = 0, minor = 0, patch = 0] = parts;
    if (!parts.length) {
      if (op === '<' || op === '>') out.push({ op: '<', nums: [0, 0, 0], pre: '0' });
      continue;
    }
    switch (op) {
      case '^': {
        const upper = major > 0 || parts.length === 1 ? [major + 1, 0, 0] : minor > 0 || parts.length === 2 ? [0, minor + 1, 0] : [0, 0, patch + 1];
        out.push({ op: '>=', nums: fill(parts), pre }, { op: '<', nums: upper, pre: '' });
        break;
      }
      case '~':
      case '~>':
        out.push({ op: '>=', nums: fill(parts), pre }, { op: '<', nums: parts.length === 1 ? [major + 1, 0, 0] : [major, minor + 1, 0], pre: '' });
        break;
      case '':
      case '=':
        if (parts.length >= 3) out.push({ op: '=', nums: fill(parts), pre });
        else out.push({ op: '>=', nums: fill(parts), pre: '' }, { op: '<', nums: bump(parts), pre: '' });
        break;
      case '>':
        out.push(parts.length >= 3 ? { op: '>', nums: fill(parts), pre } : { op: '>=', nums: bump(parts), pre: '' });
        break;
      case '>=':
        out.push({ op: '>=', nums: fill(parts), pre });
        break;
      case '<':
        out.push({ op: '<', nums: fill(parts), pre });
        break;
      case '<=':
        out.push(parts.length >= 3 ? { op: '<=', nums: fill(parts), pre } : { op: '<', nums: bump(parts), pre: '' });
        break;
      default:
        return null;
    }
  }
  return out;
}

/** A version that may stop early or end in `x`: the numbers it has, and its pre-release tag. */
function partial(text: string): { parts: number[]; pre: string } | null {
  const match = /^v?((?:\d+|\*|x|X)(?:\.(?:\d+|\*|x|X)){0,2})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  const [, numbers, pre] = match ?? [];
  if (!numbers) return null;
  const parts: number[] = [];
  for (const part of numbers.split('.')) {
    if (WILD.test(part)) break;
    parts.push(Number(part));
  }
  return { parts, pre: pre ?? '' };
}

const fill = (parts: number[]) => [at(parts, 0), at(parts, 1), at(parts, 2)];
/** The first version past a partial one: `1.2` gives 1.3.0, `1` gives 2.0.0. */
const bump = (parts: number[]) => (parts.length <= 1 ? [at(parts, 0) + 1, 0, 0] : [at(parts, 0), at(parts, 1) + 1, 0]);

function test(version: Version, comparator: Comparator): boolean {
  const order = compareParsed({ nums: fill(version.nums), pre: version.pre }, { nums: comparator.nums, pre: comparator.pre });
  switch (comparator.op) {
    case '<': return order < 0;
    case '<=': return order <= 0;
    case '>': return order > 0;
    case '>=': return order >= 0;
    case '=': return order === 0;
  }
}

/** Whether a version is in an npm range like `^19.1.0 || >=20 <22`; null when Arbor can't read the range. */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const text = range.trim();
  if (!text || WILD.test(text) || text === 'latest') return true;
  let understood = false;
  for (const alternative of text.split('||')) {
    const set = comparators(alternative);
    if (set === null) continue;
    understood = true;
    // As npm does, a pre-release only fits a range that names a pre-release of the same version.
    const allowed = !parsed.pre || set.some((comparator) => comparator.pre && comparator.nums.every((part, index) => part === at(parsed.nums, index)));
    if (allowed && set.every((comparator) => test(parsed, comparator))) return true;
  }
  return understood ? false : null;
}

/** Whether a Python version meets a specifier like `>=3.11,<4` or `~=3.12`; null when Arbor can't read it. */
export function satisfiesPython(version: string, spec: string): boolean | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  const clauses = spec.split(',').map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    // Poetry writes npm-style ranges.
    if (/^[\^~](?!=)/.test(clause)) {
      const fits = satisfiesRange(version, clause);
      if (fits === null) return null;
      if (!fits) return false;
      continue;
    }
    const match = /^(~=|===|==|!=|<=|>=|<|>)\s*v?(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause);
    const [, op, numbers, star] = match ?? [];
    if (!op || !numbers) return null;
    const wanted = numbers.split('.').map(Number);
    const prefix = (length: number) => wanted.slice(0, length).every((part, index) => at(parsed.nums, index) === part);
    const order = compareParsed(parsed, { nums: wanted, pre: '' });
    const fits = (() => {
      switch (op) {
        case '==': case '===': return star ? prefix(wanted.length) : order === 0;
        case '!=': return star ? !prefix(wanted.length) : order !== 0;
        case '~=': return wanted.length >= 2 && order >= 0 && prefix(wanted.length - 1);
        case '<=': return order <= 0;
        case '>=': return order >= 0;
        // `<3.13` leaves out 3.13's own pre-releases.
        case '<': return order < 0 && !(parsed.pre && prefix(wanted.length));
        case '>': return order > 0;
        default: return false;
      }
    })();
    if (!fits) return false;
  }
  return true;
}

/** Whether a version is what a pin like `22`, `22.17` or `v22.17.0` picks: the parts it gives must match. */
export function matchesPin(version: string, pin: string): boolean | null {
  const parsed = parseVersion(version);
  const wanted = parseVersion(pin);
  if (!parsed || !wanted) return null;
  if (!wanted.nums.every((part, index) => at(parsed.nums, index) === part)) return false;
  return !wanted.pre || wanted.pre === parsed.pre;
}

const RUST_CHANNEL = /^(stable|beta|nightly)(-\d{4}-\d{2}-\d{2})?$/;
const NODE_ANY = new Set(['node', 'latest', 'current', 'stable', 'system', 'default']);
/** Node's long-term support lines by name, for `.nvmrc` files like `lts/iron`. */
const LTS_NAMES: Record<string, number> = { argon: 4, boron: 6, carbon: 8, dubnium: 10, erbium: 12, fermium: 14, gallium: 16, hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

/**
 * How to tell whether a version (with a rustup toolchain's channel) is what a project asks for, or null when
 * Arbor doesn't know what it asks for.
 */
export function needTest(need: ToolNeed): ((version: string, label?: string | null) => boolean) | null {
  const wants = need.wants.trim();
  const known = (check: (version: string) => boolean | null) => (version: string) => check(version) === true;
  switch (need.kind) {
    case 'range':
      if (satisfiesRange('1.0.0', wants) === null) return null;
      return known((version) => satisfiesRange(version, wants));
    case 'min': {
      const floor = parseVersion(wants);
      if (!floor) return null;
      // Cargo and Go both let a pre-release of the oldest version through.
      return (version) => {
        const parsed = parseVersion(version);
        return parsed !== null && compareParsed({ nums: parsed.nums, pre: '' }, { nums: floor.nums, pre: '' }) >= 0;
      };
    }
    case 'python':
      if (satisfiesPython('3.0.0', wants) === null) return null;
      return known((version) => satisfiesPython(version, wants));
    case 'pin': {
      const word = wants.toLowerCase();
      if (need.tool === 'rust' && RUST_CHANNEL.test(word)) {
        const [channel] = word.split('-');
        const dated = word !== channel;
        return (version, label) => {
          if (label) return label === word;
          const pre = parseVersion(version)?.pre ?? '';
          return !dated && (channel === 'stable' ? !pre : pre.startsWith(channel ?? ''));
        };
      }
      if (need.tool === 'node' && NODE_ANY.has(word)) return () => true;
      if (need.tool === 'node' && (word === 'lts' || word === 'lts/*')) return (version) => at(parseVersion(version)?.nums ?? [1], 0) % 2 === 0;
      if (need.tool === 'node' && word.startsWith('lts/')) {
        const major = LTS_NAMES[word.slice(4)];
        return major === undefined ? null : (version) => at(parseVersion(version)?.nums ?? [], 0) === major;
      }
      if (need.tool === 'python' && word === 'system') return () => true;
      if (!parseVersion(wants)) return null;
      return known((version) => matchesPin(version, wants));
    }
  }
}

// ---------------------------------------------------------------------------
// What a machine has for what a project asks
// ---------------------------------------------------------------------------

/**
 * - ok: the version a shell finds first fits.
 * - managed: a version manager whose shim comes first keeps one that fits, and picks it in the project.
 * - fetch: the tool gets a version that fits itself the first time it's used there (rustup, Go, pnpm 10).
 * - unknown: Arbor can't say (what the file asks for, or what the tool said).
 * - switch: a version manager keeps one that fits, but something else comes first.
 * - differs: it's there, but not the version the project pins.
 * - mismatch: no version there fits what the project needs.
 * - missing: the tool isn't there.
 */
export type NeedState = 'ok' | 'managed' | 'fetch' | 'unknown' | 'switch' | 'differs' | 'mismatch' | 'missing';
const STATE_RANK: Record<NeedState, number> = { ok: 0, managed: 1, fetch: 2, unknown: 3, switch: 4, differs: 5, mismatch: 6, missing: 7 };
export const worseState = (a: NeedState, b: NeedState): NeedState => (STATE_RANK[b] > STATE_RANK[a] ? b : a);
/** States that want the user to do something. */
export const actionable = (state: NeedState) => STATE_RANK[state] >= STATE_RANK.switch;

export type NeedCheck = {
  need: ToolNeed;
  state: NeedState;
  /** The version a shell finds first. */
  have: string | null;
  /** The kept version that fits, for managed and switch. */
  using: KeptVersion | null;
};

/** Whether the tool a shell finds first is the shim of a version manager, which picks the version per project. */
function shimOf(manager: string, path: string | undefined): boolean {
  if (!path) return false;
  switch (manager) {
    case 'mise': return path.includes('/mise/shims/');
    case 'asdf': return path.includes('/shims/') && path.includes('asdf');
    case 'pyenv': return path.includes('/.pyenv/shims/');
    case 'volta': return path.includes('/.volta/bin/');
    case 'rustup': return path.includes('/.cargo/bin/');
    default: return false;
  }
}

export function checkNeed(need: ToolNeed, machine: MachineToolchain, project?: ProjectToolchain): NeedCheck {
  const found = machine.tools.find((tool) => tool.tool === need.tool);
  const have = found?.version ?? null;
  const fits = needTest(need);
  const result = (state: NeedState, using: KeptVersion | null = null): NeedCheck => ({ need, state, have, using });
  if (!fits) return result('unknown');
  if (have && fits(have)) return result('ok');
  // uv picks the Python a project pins, and fetches it when it has to.
  const uvProject = need.tool === 'python' && Boolean(project?.needs.some((other) => other.tool === 'uv')) && machine.tools.some((tool) => tool.tool === 'uv');
  const picks = (kept: KeptVersion) => shimOf(kept.manager, found?.path) || (uvProject && kept.manager === 'uv');
  // When two version managers keep a fitting version, the one that picks it here counts.
  const keepers = machine.kept.filter((kept) => kept.tool === need.tool && fits(kept.version, kept.label));
  const keeper = keepers.find(picks) ?? keepers[0];
  if (keeper) return result(picks(keeper) ? 'managed' : 'switch', keeper);
  if (uvProject) return result('fetch');
  if (need.tool === 'rust' && need.kind === 'pin' && shimOf('rustup', found?.path)) return result('fetch');
  if (need.tool === 'go' && need.kind === 'min' && have && compareVersions(have, '1.21') >= 0) return result('fetch');
  if (need.tool === 'pnpm' && need.field === 'packageManager' && have && at(parseVersion(have)?.nums ?? [], 0) >= 10) return result('fetch');
  if (!found) return result('missing');
  if (!have) return result('unknown');
  return result(need.kind === 'pin' ? 'differs' : 'mismatch');
}

/** A dependency whose installed version isn't what package.json asks for, or that's missing from a `node_modules`. */
export type LibraryProblem = { library: ProjectLibrary; problem: 'unmatched' | 'absent' };

export function libraryProblems(project: ProjectToolchain): LibraryProblem[] {
  const bare = new Set(notInstalled(project).map((entry) => entry.dir));
  const installedIn = new Set(project.packages.filter((entry) => entry.modules && !bare.has(entry.dir)).map((entry) => entry.dir));
  const out: LibraryProblem[] = [];
  for (const library of project.libraries) {
    if (library.installed) {
      if (satisfiesRange(library.installed, library.wants) === false) out.push({ library, problem: 'unmatched' });
    } else if (library.checked && installedIn.has(library.dir)) {
      out.push({ library, problem: 'absent' });
    }
  }
  return out;
}

/**
 * Package folders nothing is installed for on this machine: no `node_modules` where Node would look, or one
 * that has none of the folder's own dependencies (a folder that isn't a workspace, next to one that's installed).
 */
export function notInstalled(project: ProjectToolchain): PackageDir[] {
  return project.packages.filter((entry) => {
    if (entry.modules === false) return true;
    const own = project.libraries.filter((library) => library.dir === entry.dir && library.checked);
    return entry.modules === true && own.length > 0 && own.every((library) => !library.installed);
  });
}

export type PlaceCheck = {
  machine: string;
  homeDir: string;
  project: ProjectToolchain;
  checks: NeedCheck[];
  libraries: LibraryProblem[];
  state: NeedState;
};

export function checkPlace(machine: MachineToolchain, project: ProjectToolchain): PlaceCheck {
  const checks = project.missing ? [] : project.needs.map((need) => checkNeed(need, machine, project));
  const libraries = project.missing ? [] : libraryProblems(project);
  const state = checks.reduce<NeedState>((worst, check) => worseState(worst, check.state), libraries.length ? 'differs' : 'ok');
  return { machine: machine.machine, homeDir: machine.homeDir, project, checks, libraries, state };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ToolCell = { found: ToolFound | null; kept: KeptVersion[]; behind: boolean };
export type ToolRow = { tool: ToolId; newest: string | null; cells: Record<string, ToolCell>; differs: boolean; anyBehind: boolean };

/** One row a tool any machine has, with where each machine stands against the newest the fleet has. */
export function buildToolRows(machines: MachineToolchain[]): ToolRow[] {
  const scanned = machines.filter((machine) => machine.scannedAt !== null);
  const rows: ToolRow[] = [];
  for (const tool of TOOL_ORDER) {
    const founds = scanned.map((machine) => machine.tools.find((found) => found.tool === tool) ?? null);
    const kept = scanned.map((machine) => machine.kept.filter((entry) => entry.tool === tool));
    if (founds.every((found) => !found) && kept.every((list) => !list.length)) continue;
    const versions = founds.flatMap((found) => (found?.version ? [found.version] : []));
    const newest = versions.reduce<string | null>((best, version) => (best === null || compareVersions(version, best) > 0 ? version : best), null);
    const cells: Record<string, ToolCell> = {};
    scanned.forEach((machine, index) => {
      const found = founds[index] ?? null;
      const version = found?.version ? parseVersion(found.version) : null;
      const top = newest ? parseVersion(newest) : null;
      // Only a release behind on major or minor counts: patch releases come and go.
      const behind = Boolean(version && top && (at(version.nums, 0) < at(top.nums, 0) || (at(version.nums, 0) === at(top.nums, 0) && at(version.nums, 1) < at(top.nums, 1))));
      cells[machine.machine] = { found, kept: [...(kept[index] ?? [])].sort((a, b) => compareVersions(b.version, a.version)), behind };
    });
    const differs = new Set(founds.map((found) => (found ? found.version ?? '?' : '-'))).size > 1;
    rows.push({ tool, newest, cells, differs, anyBehind: Object.values(cells).some((cell) => cell.behind) });
  }
  return rows;
}

/** The projects whose copy on a machine asks for a tool, so removing it there says what it would leave short. */
export function projectsAsking(rows: ToolchainRow[], machine: string, tool: string): string[] {
  return rows.filter((row) => (row.places[machine] ?? []).some((place) => place.project.needs.some((need) => need.tool === tool))).map((row) => row.name);
}

export type ToolchainRow = {
  key: string;
  name: string;
  note: string;
  remote: string | null;
  lastUsedMs: number | null;
  places: Record<string, PlaceCheck[]>;
  /** The worst state any copy is in. */
  state: NeedState;
  /** Dependencies installed at different versions on different machines. */
  drift: LibraryDrift[];
};
export type LibraryDrift = { dir: string; name: string; versions: Record<string, string> };

/** One row a project, grouped the way Sessions › Projects' Checkouts groups them, most recently used first. */
export function buildToolchainProjects(machines: MachineToolchain[]): ToolchainRow[] {
  const rows = new Map<string, ToolchainRow>();
  for (const machine of machines) {
    for (const project of machine.projects) {
      const key = projectKey(machine.machine, project);
      let row = rows.get(key);
      if (!row) {
        const { name, note } = projectName(project, machine.homeDir);
        row = { key, name, note, remote: project.remote, lastUsedMs: null, places: {}, state: 'ok', drift: [] };
        rows.set(key, row);
      }
      const place = checkPlace(machine, project);
      (row.places[machine.machine] ??= []).push(place);
      row.state = worseState(row.state, place.state);
      if (project.lastUsedMs !== null && (row.lastUsedMs === null || project.lastUsedMs > row.lastUsedMs)) row.lastUsedMs = project.lastUsedMs;
    }
  }
  for (const row of rows.values()) {
    row.drift = libraryDrift(row);
    if (row.drift.length) row.state = worseState(row.state, 'differs');
  }
  return [...rows.values()].sort((a, b) => (b.lastUsedMs ?? 0) - (a.lastUsedMs ?? 0) || a.name.localeCompare(b.name));
}

function libraryDrift(row: ToolchainRow): LibraryDrift[] {
  const seen = new Map<string, LibraryDrift>();
  for (const [machine, places] of Object.entries(row.places)) {
    const [place] = places;
    if (!place) continue;
    for (const library of place.project.libraries) {
      if (!library.installed) continue;
      const id = `${library.dir}\u0000${library.name}`;
      const entry = seen.get(id) ?? { dir: library.dir, name: library.name, versions: {} };
      entry.versions[machine] = library.installed;
      seen.set(id, entry);
    }
  }
  return [...seen.values()].filter((entry) => new Set(Object.values(entry.versions)).size > 1).sort((a, b) => a.name.localeCompare(b.name));
}

export const needsLook = (row: ToolchainRow) => actionable(row.state);

export function matchesToolchain(row: ToolchainRow, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const places = Object.values(row.places).flat();
  return [row.name, row.note, row.remote ?? '', ...places.map((place) => place.project.path), ...places.flatMap((place) => place.project.needs.map((need) => need.tool))]
    .some((value) => value.toLowerCase().includes(text));
}

/** What one machine's copies ask for in a row, the worst first, for its cell. */
export function placeSummary(places: PlaceCheck[]): { state: NeedState; worst: NeedCheck | null; more: number; packages: number; notInstalled: number } {
  const checks = places.flatMap((place) => place.checks);
  const worst = checks.reduce<NeedCheck | null>((pick, check) => (!pick || STATE_RANK[check.state] > STATE_RANK[pick.state] ? check : pick), null);
  const state = places.reduce<NeedState>((acc, place) => worseState(acc, place.state), 'ok');
  return {
    state,
    worst: worst && worst.state !== 'ok' ? worst : null,
    /** Other checks that want something done, past the worst. */
    more: checks.filter((check) => check !== worst && actionable(check.state)).length,
    packages: places.reduce((sum, place) => sum + place.libraries.length, 0),
    notInstalled: places.reduce((sum, place) => sum + notInstalled(place.project).length, 0),
  };
}

// ---------------------------------------------------------------------------
// Libraries across projects
// ---------------------------------------------------------------------------

export type LibraryUse = { key: string; name: string; version: string; installed: boolean; dev: boolean };
export type LibraryRow = { name: string; uses: LibraryUse[]; lines: number };

/** A version's release line: its major, or `0.x` for versions before 1. */
export function releaseLine(version: string): string | null {
  const parsed = parseVersion(version.replace(/^[\^~>=<\s]+/, ''));
  if (!parsed) return null;
  const [major = 0, minor = 0] = parsed.nums;
  return major === 0 ? `0.${minor}` : String(major);
}

/**
 * The dependencies two or more projects share, each with the version every project uses: the one installed on
 * most machines, or what package.json asks for when it isn't installed anywhere. Most release lines first.
 */
export function buildLibraries(rows: ToolchainRow[]): LibraryRow[] {
  const byName = new Map<string, LibraryUse[]>();
  for (const row of rows) {
    const libraries = Object.values(row.places).flat().flatMap((place) => place.project.libraries);
    const names = new Set(libraries.map((library) => library.name));
    for (const name of names) {
      const copies = libraries.filter((library) => library.name === name);
      const counts = new Map<string, number>();
      for (const copy of copies) if (copy.installed) counts.set(copy.installed, (counts.get(copy.installed) ?? 0) + 1);
      const installed = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareVersions(b[0], a[0]))[0]?.[0] ?? null;
      const [first] = copies;
      if (!first) continue;
      const use: LibraryUse = { key: row.key, name: row.name, version: installed ?? first.wants, installed: installed !== null, dev: copies.every((copy) => copy.dev) };
      byName.set(name, [...(byName.get(name) ?? []), use]);
    }
  }
  return [...byName.entries()]
    .filter(([, uses]) => new Set(uses.map((use) => use.key)).size > 1)
    .map(([name, uses]) => ({
      name,
      uses: uses.sort((a, b) => compareVersions(b.version.replace(/^[\^~>=<\s]+/, ''), a.version.replace(/^[\^~>=<\s]+/, '')) || a.name.localeCompare(b.name)),
      lines: new Set(uses.map((use) => releaseLine(use.version) ?? use.version)).size,
    }))
    .sort((a, b) => b.lines - a.lines || b.uses.length - a.uses.length || a.name.localeCompare(b.name));
}

/** The package manager a lockfile says installs a project. */
const LOCK_MANAGER: Record<string, string> = { 'bun.lock': 'bun', 'bun.lockb': 'bun', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'package-lock.json': 'npm' };

export type LibraryBump = {
  /** Each library chosen with the version to go to: the newest any project uses. */
  libraries: { name: string; target: string }[];
  /** Each checkout on the machine that has one of them older, with its package manager and what it has now. */
  checkouts: { project: string; path: string; homeDir: string; manager: string | null; has: { name: string; version: string }[] }[];
};

/**
 * What bumping the chosen shared libraries means on each machine: the checkouts there that use one at a version older
 * than the newest any project uses, so one prompt per machine does the batch. Machines with most checkouts first.
 */
export function libraryBumps(libraries: LibraryRow[], chosen: ReadonlySet<string>, projects: ToolchainRow[]): Map<string, LibraryBump> {
  const out = new Map<string, LibraryBump>();
  for (const row of libraries.filter((entry) => chosen.has(entry.name))) {
    const [newest] = row.uses;
    if (!newest) continue;
    const target = newest.version.replace(/^[\^~>=<\s]+/, '');
    for (const use of row.uses) {
      if (compareVersions(use.version.replace(/^[\^~>=<\s]+/, ''), target) >= 0) continue;
      const project = projects.find((entry) => entry.key === use.key);
      for (const [machine, places] of Object.entries(project?.places ?? {})) {
        for (const place of places.filter((entry) => !entry.project.missing)) {
          const bump = out.get(machine) ?? { libraries: [], checkouts: [] };
          if (!bump.libraries.some((entry) => entry.name === row.name)) bump.libraries.push({ name: row.name, target });
          let checkout = bump.checkouts.find((entry) => entry.path === place.project.path);
          if (!checkout) {
            const lockfile = place.project.packages.find((entry) => entry.lockfile)?.lockfile ?? null;
            checkout = { project: use.name, path: place.project.path, homeDir: place.homeDir, manager: lockfile ? LOCK_MANAGER[lockfile] ?? null : null, has: [] };
            bump.checkouts.push(checkout);
          }
          if (!checkout.has.some((entry) => entry.name === row.name)) checkout.has.push({ name: row.name, version: use.version });
          out.set(machine, bump);
        }
      }
    }
  }
  return new Map([...out.entries()].sort((a, b) => b[1].checkouts.length - a[1].checkouts.length));
}

export const matchesLibrary = (row: LibraryRow, query: string) => {
  const text = query.trim().toLowerCase();
  return !text || row.name.toLowerCase().includes(text) || row.uses.some((use) => use.name.toLowerCase().includes(text));
};

// ---------------------------------------------------------------------------
// Node's versions
// ---------------------------------------------------------------------------

/** The version managers whose Node versions Arbor installs, removes and makes the default. */
export const NODE_MANAGERS = ['nvm', 'fnm', 'mise', 'asdf', 'volta'] as const;
export type NodeManager = NodeChange['manager'];

export const changeNodeVersions = (machine: string, changes: NodeChange[]) =>
  tracked('node-versions-changed', invokeCommand('change_node_versions', { machine, changes }), { count: changes.length });

const isNodeManager = (manager: string): manager is NodeManager => (NODE_MANAGERS as readonly string[]).includes(manager);

/** Whether the node a shell finds first on the machine is this kept version, as the backend decides it: that one isn't removed. */
export function isDefaultNode(machine: MachineToolchain, kept: KeptVersion): boolean {
  const node = machine.tools.find((tool) => tool.tool === 'node');
  if (!node) return false;
  const fromManager: Record<NodeManager, boolean> = {
    nvm: node.path.includes('/.nvm/'),
    fnm: node.path.includes('fnm'),
    mise: node.path.includes('/mise/'),
    asdf: node.path.includes('/.asdf/'),
    volta: node.path.includes('/.volta/'),
  };
  if (!isNodeManager(kept.manager) || !fromManager[kept.manager]) return false;
  const bare = (version: string) => version.replace(/^v/, '');
  return node.path.includes(`/${kept.version}/`) || (node.version !== null && bare(node.version) === bare(kept.version));
}

/**
 * One of Node's versions a machine keeps, for its list: whether it's the default, which of the machine's projects pin
 * a version it is (so removing it sends them looking for another), and what can be done with it.
 */
export type NodeVersion = { kept: KeptVersion; isDefault: boolean; pinnedBy: string[]; canRemove: boolean; canDefault: boolean };

export function nodeVersions(machine: MachineToolchain): NodeVersion[] {
  return machine.kept
    .filter((kept) => kept.tool === 'node')
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((kept) => {
      const isDefault = isDefaultNode(machine, kept);
      const pinnedBy = machine.projects
        .filter((project) => !project.missing && project.needs.some((need) => need.tool === 'node' && need.kind === 'pin' && Boolean(needTest(need)?.(kept.version, kept.label))))
        .map((project) => projectName(project, machine.homeDir).name);
      const managed = isNodeManager(kept.manager);
      return { kept, isDefault, pinnedBy, canRemove: managed && kept.manager !== 'volta' && !isDefault, canDefault: managed && !isDefault };
    });
}

export const nodeVersionKey = (entry: NodeVersion) => `${entry.kept.manager}:${entry.kept.version}`;

/**
 * The versions a cleanup picks: ones Arbor can remove that no project pins and that aren't the newest the machine
 * keeps on their major line, so every line still in use keeps its latest patch.
 */
export function olderNodeVersions(versions: NodeVersion[]): NodeVersion[] {
  const newest = new Map<string, string>();
  for (const entry of versions) {
    const line = releaseLine(entry.kept.version) ?? entry.kept.version;
    const current = newest.get(line);
    if (current === undefined || compareVersions(entry.kept.version, current) > 0) newest.set(line, entry.kept.version);
  }
  return versions.filter((entry) => entry.canRemove && !entry.pinnedBy.length
    && compareVersions(entry.kept.version, newest.get(releaseLine(entry.kept.version) ?? entry.kept.version) ?? entry.kept.version) < 0);
}

/** The backend takes this many Node changes in one run, so a bigger cleanup goes in several. */
export const MOST_NODE_CHANGES = 12;

/** The version managers on a machine that can install Node: the ones keeping a version, or giving the shell its node. */
export function nodeInstallers(machine: MachineToolchain): NodeManager[] {
  const node = machine.tools.find((tool) => tool.tool === 'node');
  return NODE_MANAGERS.filter((manager) => machine.kept.some((kept) => kept.tool === 'node' && kept.manager === manager)
    || (manager === 'volta' && Boolean(node?.path.includes('/.volta/'))));
}

/** A version to install as the backend takes it: `22`, `22.20` or `22.20.0`, with or without a v. */
export const installableNode = (version: string) => /^v?\d{1,3}(\.\d{1,4}){0,2}$/.test(version.trim());

import { invokeCommand } from '../native/commands';
import type { MessageKey } from '../i18n/resources';
import type {
  HomeAgent,
  OverrideState,
  SetupHome,
  SetupItem,
  SetupMachine,
  SetupSkillFile,
  SharedHome,
  SkillOverride,
} from '../native/types';

export type SetupItemKind =
  | 'instructions'
  | 'import'
  | 'rule'
  | 'skill'
  | 'subagent'
  | 'command'
  | 'hook'
  | 'mcp'
  | 'plugin'
  | 'marketplace'
  | 'setting'
  | 'env'
  | 'profile';

export const SETUP_INVENTORY_UPDATED_EVENT = 'setup-inventory-updated';

export const fetchSetupInventory = () => invokeCommand('get_setup_inventory');
/** Scans `machine`, or every machine, in the background. `staleOnly` skips machines scanned lately or not answering. */
export const scanSetup = (machine: string | null, staleOnly: boolean) => invokeCommand('scan_setup', { machine, staleOnly });
export const readSetupText = (machine: string, path: string) => invokeCommand('read_setup_text', { machine, path });
export const readSetupSkill = (machine: string, path: string) => invokeCommand('read_setup_skill', { machine, path });

/** The order kinds are listed in. */
export const SETUP_KINDS: readonly SetupItemKind[] = [
  'instructions', 'import', 'rule', 'skill', 'subagent', 'command', 'hook', 'mcp', 'plugin', 'marketplace', 'setting', 'env', 'profile',
];

export const homeKey = (home: Pick<SetupHome, 'agent' | 'path'>) => `${home.agent}:${home.path}`;

/** Entries of a Codex home Setup reads, in the order it names them when one is shared. */
const CODEX_ENTRIES = ['AGENTS.override.md', 'AGENTS.md', 'config.toml', 'hooks.json', 'rules', 'prompts', 'skills'];

/** Whether a home's `entry` is a link into the Codex home it shares. */
export const sharesEntry = (home: Pick<SetupHome, 'shares'> | null | undefined, entry: string) => Boolean(home?.shares?.entries.includes(entry));

/** The entries of a shared home that Setup reads, like config.toml and skills; the rest (sessions, caches) aren't its business. */
export const sharedSetupEntries = (shares: SharedHome) =>
  shares.entries.filter((entry) => CODEX_ENTRIES.includes(entry) || entry.endsWith('.config.toml'))
    .sort((a, b) => (CODEX_ENTRIES.indexOf(a) + 1 || 99) - (CODEX_ENTRIES.indexOf(b) + 1 || 99) || a.localeCompare(b));

/**
 * What a home loads through the links into the home it shares: that home's items in the shared entries. The scan
 * leaves them out of the shadow home, so they're compared once, where they are.
 */
export function sharedItems(machine: SetupMachine, home: SetupHome): SetupItem[] {
  const shares = home.shares;
  if (!shares) return [];
  const source = machine.homes.find((entry) => entry.agent === home.agent && entry.path === shares.home);
  return (source?.items ?? []).filter((item) => {
    const rest = item.path?.startsWith(`${shares.home}/`) ? item.path.slice(shares.home.length + 1) : null;
    return rest !== null && shares.entries.includes(rest.split('/')[0] ?? rest);
  });
}

/** Machines on which a home shares entries with another, and which. */
export const sharingMachines = (machines: SetupMachine[], key: string) =>
  machines.flatMap((machine) => {
    const home = machine.homes.find((entry) => homeKey(entry) === key);
    return home?.shares ? [{ machine: machine.machine, shares: home.shares }] : [];
  });

/** Kinds a managed-settings policy can set. */
const POLICY_KINDS: ReadonlySet<SetupItemKind> = new Set(['setting', 'env', 'hook', 'plugin', 'marketplace']);

/**
 * Whether the machine's managed-settings policy sets this for its Claude Code homes: Claude Code then goes by the
 * policy whatever a home's settings say, and Setup leaves it alone.
 */
export const policySets = (machine: Pick<SetupMachine, 'policy'> | null | undefined, kind: SetupItemKind, name: string) =>
  Boolean(machine?.policy?.keys.some((key) => key.kind === kind && key.name === name));

/** What a Claude Code home's settings say about a skill, by its folder's name. */
export const skillOverride = (home: Pick<SetupHome, 'skillOverrides'> | null | undefined, name: string): SkillOverride | null =>
  home?.skillOverrides.find((entry) => entry.name === name) ?? null;

/** Whether a home's settings turn a skill off, so whatever copy it has doesn't load. */
export const turnedOff = (home: Pick<SetupHome, 'skillOverrides'> | null | undefined, name: string) => skillOverride(home, name)?.state === 'off';

const OVERRIDE_LABEL: Record<OverrideState, MessageKey> = {
  on: 'setup.override.on',
  nameOnly: 'setup.override.nameOnly',
  userInvocableOnly: 'setup.override.userInvocableOnly',
  off: 'setup.override.off',
};
const OVERRIDE_HINT: Record<OverrideState, MessageKey> = {
  on: 'setup.override.hint.on',
  nameOnly: 'setup.override.hint.nameOnly',
  userInvocableOnly: 'setup.override.hint.userInvocableOnly',
  off: 'setup.override.hint.off',
};

/** The short word for an override that changes how a loaded skill is offered to the model; none for on or off. */
export const overrideLabel = (override: SkillOverride | null): MessageKey | null =>
  override && override.state !== 'on' && override.state !== 'off' ? OVERRIDE_LABEL[override.state] : null;

/** What an override does to the skill, then where it's set, as sentences with what each needs filled in. */
export const overrideWords = (override: SkillOverride): [MessageKey, Record<string, string>][] => [
  [OVERRIDE_HINT[override.state], {}],
  [override.source === 'policy' ? 'setup.override.policy' : 'setup.override.settings', { file: override.file }],
];

/** How a home reads: one of the agents' own, the shared skills, or another on the machine's list of agent homes. */
export type HomeLook = { id: 'claude' | 'codex' | 'shared' | 'other'; agent: HomeAgent; path: string };

export function homeLook(key: string): HomeLook {
  const at = key.indexOf(':');
  const agent = key.slice(0, at) as HomeAgent;
  const path = key.slice(at + 1);
  if (agent === 'claude' && path === '~/.claude') return { id: 'claude', agent, path };
  if (agent === 'codex' && path === '~/.codex') return { id: 'codex', agent, path };
  if (agent === 'shared') return { id: 'shared', agent, path };
  return { id: 'other', agent, path };
}

const HOME_ORDER: Record<HomeLook['id'], number> = { claude: 0, codex: 1, shared: 2, other: 3 };

/** Every home found on any machine: Claude Code's, Codex's, the shared skills, then the rest by path. */
export function homeKeys(machines: SetupMachine[]): string[] {
  const keys = new Set(machines.flatMap((machine) => machine.homes.map(homeKey)));
  return [...keys].sort((a, b) => {
    const lookA = homeLook(a);
    const lookB = homeLook(b);
    return HOME_ORDER[lookA.id] - HOME_ORDER[lookB.id] || lookA.path.localeCompare(lookB.path) || lookA.agent.localeCompare(lookB.agent);
  });
}

/** The machine others are compared with: the one chosen, while it's there, else this one, else the first. */
export function resolveReference(machines: SetupMachine[], chosen: string | null): string | null {
  if (chosen && machines.some((machine) => machine.machine === chosen)) return chosen;
  return (machines.find((machine) => machine.local) ?? machines[0])?.machine ?? null;
}

/**
 * How a machine's copy compares with the reference machine's.
 * - `reference`: the reference machine's own copy.
 * - `same`, `different`: both have it, and it matches or doesn't.
 * - `missing`: the reference has it and this machine doesn't.
 * - `extra`: only this machine has it.
 * - `absent`: neither has it.
 * - `present`: there's nothing to compare it with, as the reference hasn't this home.
 * - `noHome`: this machine hasn't the home at all.
 * - `unknown`: this machine hasn't been scanned yet.
 * - `turnedOff`: this machine's Claude Code settings turn the skill off, so it doesn't load there, whatever copy the
 *   home has, and isn't compared. Where the reference's turn it off, the others have nothing to compare with.
 * - `enforced`: this machine's managed-settings policy sets it for Claude Code, so the home's own setting doesn't
 *   count and isn't compared. Where the reference's policy sets it, the others have nothing to compare with.
 */
export type CellState =
  | 'reference' | 'same' | 'different' | 'missing' | 'extra' | 'absent' | 'present' | 'noHome' | 'unknown' | 'turnedOff' | 'enforced';
/**
 * `override`: what the home's settings say about the skill, for a skill's row. `policy`: the policy file that sets it,
 * for an `enforced` cell.
 */
export type SetupCell = { machine: string; state: CellState; item: SetupItem | null; override: SkillOverride | null; policy: string | null };
export type SetupRow = { key: string; kind: SetupItemKind; name: string; cells: SetupCell[]; differs: boolean };
export type SetupGroup = { kind: SetupItemKind; rows: SetupRow[] };

export const DIFFERING: ReadonlySet<CellState> = new Set(['different', 'missing', 'extra']);

const rowKey = (item: Pick<SetupItem, 'kind' | 'name'>) => `${item.kind}\u0000${item.name}`;

/** Each thing any machine's copy of a home holds, by kind, and how every machine's copy compares with the reference's. */
export function buildMatrix(machines: SetupMachine[], key: string, reference: string | null): SetupGroup[] {
  const homes = machines.map((machine) => machine.homes.find((home) => homeKey(home) === key) ?? null);
  const scanned = machines.map((machine) => machine.scannedAt !== null || machine.homes.length > 0);
  const referenceIndex = machines.findIndex((machine) => machine.machine === reference);
  const referenceHome = referenceIndex >= 0 ? homes[referenceIndex] : null;
  const byKey = homes.map((home) => new Map((home?.items ?? []).map((item) => [rowKey(item), item])));
  const rows = new Map<string, { kind: SetupItemKind; name: string }>();
  for (const home of homes) for (const item of home?.items ?? []) rows.set(rowKey(item), { kind: item.kind, name: item.name });
  // A policy applies to every Claude Code home on its machine, so what it sets is a row there even where no home sets it.
  const enforcing = (index: number) => homes[index]?.agent === 'claude' ? machines[index]?.policy ?? null : null;
  machines.forEach((_, index) => {
    for (const key of enforcing(index)?.keys ?? []) if (POLICY_KINDS.has(key.kind)) rows.set(rowKey(key), { kind: key.kind, name: key.name });
  });

  const groups = new Map<SetupItemKind, SetupRow[]>();
  for (const [id, { kind, name }] of rows) {
    const theirs = referenceHome ? byKey[referenceIndex]!.get(id) ?? null : null;
    const skill = kind === 'skill';
    const enforced = (index: number) => policySets({ policy: enforcing(index) }, kind, name);
    // A skill the reference turns off doesn't load there, and what its policy sets isn't its home's to share, so
    // there's nothing to hold the others to.
    const referenceOff = (skill && turnedOff(referenceHome, name)) || (referenceIndex >= 0 && enforced(referenceIndex));
    const cells = machines.map((machine, index): SetupCell => {
      const item = byKey[index]!.get(id) ?? null;
      const home = homes[index] ?? null;
      const override = skill ? skillOverride(home, name) : null;
      const cell = (state: CellState, policy: string | null = null): SetupCell => ({ machine: machine.machine, state, item, override, policy });
      if (!scanned[index]) return cell('unknown');
      if (!home) return cell('noHome');
      if (override?.state === 'off') return cell('turnedOff');
      if (enforced(index)) return cell('enforced', enforcing(index)?.file ?? null);
      if (index === referenceIndex) return cell(item ? 'reference' : 'absent');
      if (!referenceHome || referenceOff) return cell(item ? 'present' : 'absent');
      if (item && theirs) return cell(item.sum === theirs.sum ? 'same' : 'different');
      return cell(item ? 'extra' : theirs ? 'missing' : 'absent');
    });
    const row = { key: id, kind, name, cells, differs: cells.some((cell) => DIFFERING.has(cell.state)) };
    groups.set(kind, [...(groups.get(kind) ?? []), row]);
  }
  return SETUP_KINDS.flatMap((kind) => {
    const kindRows = groups.get(kind);
    return kindRows ? [{ kind, rows: kindRows.sort((a, b) => a.name.localeCompare(b.name)) }] : [];
  });
}

/** How many things in a home differ somewhere from the reference. */
export const differingRows = (groups: SetupGroup[]) => groups.reduce((total, group) => total + group.rows.filter((row) => row.differs).length, 0);

/** How many of a machine's things differ from the reference's, in the homes given. */
export function machineDifferences(groups: SetupGroup[], machine: string): number {
  let total = 0;
  for (const group of groups) for (const row of group.rows) if (row.cells.some((cell) => cell.machine === machine && DIFFERING.has(cell.state))) total += 1;
  return total;
}

// ---------------------------------------------------------------------------
// Comparing skills
// ---------------------------------------------------------------------------

export type SkillFileChange = { path: string; state: 'same' | 'changed' | 'added' | 'removed'; before: SetupSkillFile | null; after: SetupSkillFile | null };

/** A skill's files on two machines: changed, added and removed ones first, then the ones that match. */
export function compareSkillFiles(before: SetupSkillFile[], after: SetupSkillFile[]): SkillFileChange[] {
  const theirs = new Map(before.map((file) => [file.path, file]));
  const ours = new Map(after.map((file) => [file.path, file]));
  const paths = [...new Set([...theirs.keys(), ...ours.keys()])].sort();
  const order = { changed: 0, added: 1, removed: 2, same: 3 };
  return paths
    .map((path): SkillFileChange => {
      const a = theirs.get(path) ?? null;
      const b = ours.get(path) ?? null;
      const state = !a ? 'added' : !b ? 'removed' : a.sum === b.sum ? 'same' : 'changed';
      return { path, state, before: a, after: b };
    })
    .sort((a, b) => order[a.state] - order[b.state] || a.path.localeCompare(b.path));
}

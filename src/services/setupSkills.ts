import { invokeCommand } from '../native/commands';
import { sharesEntry, skillOverride } from './setupInventory';
import type {
  SetupHome,
  SetupItem,
  SetupMachine,
  SetupRepo,
  SkillAction,
  SkillChange,
  SkillOverride,
  SkillUsage,
} from '../native/types';
import { tracked } from './productAnalytics';

/**
 * Each machine keeps one store of skills, ~/.agents/skills, which Codex loads itself. Claude Code loads only a home's
 * own skills folder, so a Claude Code home loads a store skill through a link to it, and turning it on or off there
 * adds or removes the link.
 */

export const applySkillChanges = (machine: string, changes: SkillChange[]) => tracked('skills-changed', invokeCommand('apply_skill_changes', { machine, changes }), { count: changes.length });

export const getSkillUsage = (days: number) => invokeCommand('get_skill_usage', { days });

/** The machine's store of skills, and the home the scan lists it under. */
export const STORE = '~/.agents/skills';
const STORE_HOME = '~/.agents';

/** A Claude Code or Codex home whose skills Arbor can change. */
export type SkillHome = {
  path: string;
  agent: 'claude' | 'codex';
  /** Where its skills folder leads, when it's a link: its skills are then that folder's, and Arbor leaves them alone. */
  folderLink: string | null;
};

/**
 * Where a skill stands in one place.
 * - `store`: the store's own folder. In the store's column, a link the store keeps to a skill is `elsewhere`.
 * - `linked`: a link to the store's copy. On, in a Claude Code home; a second copy, in Codex's.
 * - `off`: the store has it and this Claude Code home hasn't, so it doesn't load it.
 * - `loads`: Codex's home hasn't got it, and Codex loads the store's.
 * - `copy`, `drifted`: the home's own copy, the same as the store's or different from it.
 * - `own`: the home's own copy of a skill the store hasn't got.
 * - `elsewhere`: a link to a skill somewhere other than the store.
 * - `broken`: a link to nothing.
 * - `notSkill`: a folder, or a link to one, without a SKILL.md, which the agents don't load.
 * - `viaFolder`: the home's whole skills folder is a link, so the skill is that folder's.
 * - `none`: nothing by that name, and nothing the store has.
 */
export type SkillPlace = 'store' | 'linked' | 'off' | 'loads' | 'copy' | 'drifted' | 'own' | 'elsewhere' | 'broken' | 'notSkill' | 'viaFolder' | 'none';

/** `override`: what a Claude Code home's settings say about the skill, whatever its place. */
export type SkillCell = { home: SkillHome; place: SkillPlace; item: SetupItem | null; override: SkillOverride | null };

/** A Claude Code home's settings turn the skill off there, so it doesn't load whatever its place. */
export const isTurnedOff = (cell: Pick<SkillCell, 'override'>) => cell.override?.state === 'off';
export type SkillRow = {
  /** Its folder's name, which Claude Code knows it by. */
  name: string;
  store: SetupItem | null;
  storePlace: SkillPlace;
  cells: SkillCell[];
  /** The name its SKILL.md gives, where that isn't its folder's. */
  declaredName: string | null;
  manualOnly: boolean;
  /** Where `npx skills` installed the store's copy from. */
  source: string | null;
};
export type SkillsView = {
  /** The store's own home, when the machine has ~/.agents. */
  store: SetupHome | null;
  homes: SkillHome[];
  rows: SkillRow[];
  /** Codex homes whose skills folder is a link into another Codex home's, left out as their skills are that home's. */
  sharing: { path: string; home: string }[];
};

const skillsIn = (home: SetupHome | null | undefined) =>
  new Map((home?.items ?? []).filter((item) => item.kind === 'skill').map((item) => [item.name, item]));

/** What a place holds, as a change must still find it: null for something Arbor doesn't change. */
export function placeState(item: SetupItem | null | undefined): string | null {
  if (!item) return '-';
  if (item.link) return `L${item.link}`;
  return item.sum ? `D${item.sum}` : null;
}

const homeOrder = (home: SkillHome) => (home.agent === 'claude' ? 0 : 2) + (home.path === (home.agent === 'claude' ? '~/.claude' : '~/.codex') ? 0 : 1);

/** Where a store skill's link leads from a home. */
const storePath = (name: string) => `${STORE}/${name}`;

function homePlace(home: SkillHome, item: SetupItem | null, store: SetupItem | null, name: string): SkillPlace {
  const inStore = store !== null && store.sum !== null;
  if (home.folderLink) return item ? 'viaFolder' : 'none';
  if (!item) return inStore ? (home.agent === 'claude' ? 'off' : 'loads') : 'none';
  if (item.link) {
    if (item.link === storePath(name)) return item.sum !== null ? 'linked' : 'broken';
    if (!item.skill) return 'broken';
    return item.sum !== null ? 'elsewhere' : 'notSkill';
  }
  if (item.sum === null) return 'notSkill';
  if (!inStore) return 'own';
  return item.sum === store.sum ? 'copy' : 'drifted';
}

function storePlace(item: SetupItem | null): SkillPlace {
  if (!item) return 'none';
  if (item.link) return item.sum !== null ? 'elsewhere' : item.skill ? 'notSkill' : 'broken';
  return item.sum !== null ? 'store' : 'notSkill';
}

/** Every skill in a machine's store and in its Claude Code and Codex homes, and where each stands in each. */
export function skillsView(machine: SetupMachine): SkillsView {
  const store = machine.homes.find((home) => home.agent === 'shared' && home.path === STORE_HOME) ?? null;
  const sharing = machine.homes
    .filter((home) => home.agent === 'codex' && sharesEntry(home, 'skills'))
    .map((home) => ({ path: home.path, home: home.shares?.home ?? '' }));
  const homes: SkillHome[] = machine.homes
    .filter((home): home is SetupHome & { agent: 'claude' | 'codex' } => home.agent === 'claude' || home.agent === 'codex')
    .filter((home) => !sharing.some((entry) => entry.path === home.path))
    .map((home) => ({ path: home.path, agent: home.agent, folderLink: home.skillsLink }))
    .sort((a, b) => homeOrder(a) - homeOrder(b) || a.path.localeCompare(b.path));
  const stored = skillsIn(store);
  const setupHome = (home: SkillHome) => machine.homes.find((entry) => entry.path === home.path && entry.agent === home.agent);
  const held = new Map(homes.map((home) => [home.path, skillsIn(setupHome(home))]));
  const settings = new Map(homes.map((home) => [home.path, setupHome(home)]));
  const names = new Set([...stored.keys(), ...[...held.values()].flatMap((items) => [...items.keys()])]);
  const rows = [...names].sort((a, b) => a.localeCompare(b)).map((name): SkillRow => {
    const item = stored.get(name) ?? null;
    const cells = homes.map((home): SkillCell => {
      const own = held.get(home.path)?.get(name) ?? null;
      const override = home.agent === 'claude' ? skillOverride(settings.get(home.path), name) : null;
      return { home, item: own, place: homePlace(home, own, item, name), override };
    });
    const facts = item?.skill ?? cells.find((cell) => cell.item?.skill)?.item?.skill ?? null;
    return {
      name,
      store: item,
      storePlace: storePlace(item),
      cells,
      declaredName: facts?.declaredName && facts.declaredName !== name ? facts.declaredName : null,
      manualOnly: facts?.manualOnly ?? false,
      source: item?.skill?.source ?? null,
    };
  });
  return { store, homes, rows, sharing };
}

/** Changes chosen on the page, one per skill in a home, by `changeKey`. */
export type PendingSkills = Record<string, SkillAction>;
export const changeKey = (home: string, name: string) => `${home}\u0000${name}`;

const adoptedIn = (row: SkillRow, pending: PendingSkills) =>
  row.cells.find((cell) => pending[changeKey(cell.home.path, row.name)] === 'adopt')?.home.path ?? null;

/**
 * What can be done to a skill in one home, as the backend allows it: a link needs the store's skill, or one moving
 * into it with the same change; only the store's own folder is put aside for another copy; nothing is changed in a
 * home whose skills folder is a link, or while the store holds something by the name that isn't a skill.
 */
export function cellOptions(row: SkillRow, cell: SkillCell, pending: PendingSkills = {}): SkillAction[] {
  const storeState = placeState(row.store);
  if (storeState === null || cell.home.folderLink || placeState(cell.item) === null) return [];
  const adopting = adoptedIn(row, pending);
  const linkable = (row.store !== null && row.store.sum !== null) || (adopting !== null && adopting !== cell.home.path);
  const replaceable = row.store === null || (!row.store.link && row.store.sum !== null);
  const claude = cell.home.agent === 'claude';
  // A link to the store's copy is no use where the home's settings turn the skill off.
  const linking = claude && linkable && !isTurnedOff(cell);
  switch (cell.place) {
    case 'off':
    case 'none':
      return linking ? ['link'] : [];
    case 'copy':
      return linking ? ['useStore', 'remove'] : ['remove'];
    case 'drifted':
      return [...(linking ? ['useStore' as const] : []), ...(replaceable ? ['adopt' as const] : []), 'remove'];
    case 'own':
      return [...(linking ? ['useStore' as const] : []), ...(replaceable ? ['adopt' as const] : []), 'remove'];
    case 'linked':
    case 'elsewhere':
    case 'broken':
    case 'notSkill':
      return ['remove'];
    default:
      return [];
  }
}

/**
 * The chosen changes that still hold: one for a skill or home the machine no longer has goes, and so does a link
 * that needed a skill moving into the store once that move goes.
 */
function settle(view: SkillsView, pending: PendingSkills): PendingSkills {
  let current = pending;
  for (;;) {
    const settled: PendingSkills = {};
    for (const row of view.rows) {
      for (const cell of row.cells) {
        const key = changeKey(cell.home.path, row.name);
        const action = current[key];
        if (action && cellOptions(row, cell, current).includes(action)) settled[key] = action;
      }
    }
    if (Object.keys(settled).length === Object.keys(current).length) return settled;
    current = settled;
  }
}

/** The chosen changes that still hold after a machine is read again. */
export const settleSkills = settle;

/** Chooses `action` for a skill in a home, or clears it. Only one home's copy of a skill can move into the store. */
export function choose(view: SkillsView, pending: PendingSkills, row: SkillRow, cell: SkillCell, action: SkillAction | null): PendingSkills {
  const next = { ...pending };
  const key = changeKey(cell.home.path, row.name);
  if (action === 'adopt') {
    for (const other of row.cells) if (next[changeKey(other.home.path, row.name)] === 'adopt') delete next[changeKey(other.home.path, row.name)];
  }
  if (action) next[key] = action;
  else delete next[key];
  return settle(view, next);
}

/** Adds changes, leaving any already chosen for the same skill in the same home as they are. */
export function addChanges(view: SkillsView, pending: PendingSkills, changes: PlannedSkill[]): PendingSkills {
  let next = pending;
  for (const change of changes) {
    if (next[changeKey(change.cell.home.path, change.row.name)]) continue;
    next = choose(view, next, change.row, change.cell, change.action);
  }
  return next;
}

export type PlannedSkill = { row: SkillRow; cell: SkillCell; action: SkillAction };

/** The chosen changes, in the page's order. */
export function plannedSkills(view: SkillsView, pending: PendingSkills): PlannedSkill[] {
  return view.rows.flatMap((row) => row.cells.flatMap((cell) => {
    const action = pending[changeKey(cell.home.path, row.name)];
    return action ? [{ row, cell, action }] : [];
  }));
}

/** The changes to send, each with what the last scan found, or null when one can't be made as the scan found things. */
export function skillChanges(view: SkillsView, pending: PendingSkills): SkillChange[] | null {
  const planned = plannedSkills(view, pending);
  const changes: SkillChange[] = [];
  for (const { row, cell, action } of planned) {
    const homeBefore = placeState(cell.item);
    const storeBefore = placeState(row.store);
    if (homeBefore === null || storeBefore === null || !cellOptions(row, cell, pending).includes(action)) return null;
    changes.push({ home: cell.home.path, name: row.name, action, homeBefore, storeBefore });
  }
  return changes;
}

/**
 * Changes worth making, a group at a time:
 * - `linkCopies`: Claude Code homes' copies that match the store's give way to links to it.
 * - `codexTwice`: Codex's old skills folder has copies of, or links to, store skills, which Codex loads twice.
 * - `intoStore`: skills only homes have move into the store, where every agent can load them. One home's copy
 *   moves in and matching copies elsewhere give way to it; copies that differ are left to be looked at.
 * - `match`: another Claude Code home, like one T3 Code keeps, turns on the store skills ~/.claude has on.
 */
export type SkillSuggestion = { kind: 'linkCopies' | 'codexTwice' | 'intoStore' | 'match'; home: string | null; changes: PlannedSkill[] };

export function skillSuggestions(view: SkillsView, pending: PendingSkills = {}): SkillSuggestion[] {
  // A skill a home's settings turn off is left as it is there: it doesn't load, whatever its place.
  const free = (row: SkillRow, cell: SkillCell) =>
    !pending[changeKey(cell.home.path, row.name)] && placeState(row.store) !== null && !cell.home.folderLink && !isTurnedOff(cell);
  const suggestions: SkillSuggestion[] = [];
  const linkCopies = view.rows.flatMap((row) => row.cells
    .filter((cell) => cell.home.agent === 'claude' && cell.place === 'copy' && free(row, cell))
    .map((cell) => ({ row, cell, action: 'useStore' as const })));
  if (linkCopies.length) suggestions.push({ kind: 'linkCopies', home: null, changes: linkCopies });

  const codexTwice = view.rows.flatMap((row) => row.cells
    .filter((cell) => cell.home.agent === 'codex' && (cell.place === 'copy' || cell.place === 'linked') && free(row, cell))
    .map((cell) => ({ row, cell, action: 'remove' as const })));
  if (codexTwice.length) suggestions.push({ kind: 'codexTwice', home: null, changes: codexTwice });

  const intoStore = view.rows.flatMap((row) => {
    const own = row.cells.filter((cell) => cell.place === 'own');
    if (row.store !== null || !own.length || !own.every((cell) => free(row, cell) && cell.item?.sum === own[0]!.item?.sum)) return [];
    const [first, ...rest] = own;
    return [
      { row, cell: first!, action: 'adopt' as const },
      ...rest.map((cell) => ({ row, cell, action: cell.home.agent === 'claude' ? 'useStore' as const : 'remove' as const })),
    ];
  });
  if (intoStore.length) suggestions.push({ kind: 'intoStore', home: null, changes: intoStore });

  const main = view.homes.find((home) => home.agent === 'claude' && home.path === '~/.claude');
  if (main) {
    const on = (row: SkillRow) => {
      const cell = row.cells.find((entry) => entry.home === main);
      if (!cell || isTurnedOff(cell)) return false;
      return cell.place === 'linked' || (cell.place === 'viaFolder' && main.folderLink === STORE && row.storePlace === 'store');
    };
    for (const home of view.homes.filter((entry) => entry.agent === 'claude' && entry !== main && !entry.folderLink)) {
      const changes = view.rows.flatMap((row) => {
        const cell = row.cells.find((entry) => entry.home === home);
        return cell && cell.place === 'off' && on(row) && free(row, cell) ? [{ row, cell, action: 'link' as const }] : [];
      });
      if (changes.length) suggestions.push({ kind: 'match', home: home.path, changes });
    }
  }
  return suggestions;
}

/** How many store skills each home loads, how many of its own, and how many its settings turn off. */
export function homeCounts(view: SkillsView, home: SkillHome): { fromStore: number; own: number; turnedOff: number } {
  let fromStore = 0;
  let own = 0;
  let turnedOff = 0;
  for (const row of view.rows) {
    const cell = row.cells.find((entry) => entry.home === home);
    const place = cell?.place;
    if (cell && isTurnedOff(cell)) turnedOff += 1;
    else if (place === 'linked' || place === 'loads' || (place === 'viaFolder' && home.folderLink === STORE)) fromStore += 1;
    else if (place === 'copy' || place === 'drifted' || place === 'own' || place === 'elsewhere' || place === 'viaFolder') own += 1;
  }
  return { fromStore, own, turnedOff };
}

/** A skill's use lately, by its folder's name or the one its SKILL.md gives. */
export function usageFor(row: SkillRow, usage: ReadonlyMap<string, SkillUsage>): SkillUsage | null {
  return usage.get(row.name) ?? (row.declaredName ? usage.get(row.declaredName) ?? null : null);
}

/**
 * Whether a skill's row needs a look: a home's copy isn't the store's, a link leads nowhere, or Codex loads it twice.
 * A home whose settings turn the skill off doesn't load it, so what's there isn't counted.
 */
export function needsLook(row: SkillRow): boolean {
  return row.storePlace === 'broken' || row.cells.some((cell) => !isTurnedOff(cell) && (cell.place === 'copy' || cell.place === 'drifted'
    || cell.place === 'own' || cell.place === 'broken' || (cell.home.agent === 'codex' && cell.place === 'linked')));
}

/** Places where a home loads the skill, once its settings don't turn it off. */
const LOADING: ReadonlySet<SkillPlace> = new Set(['linked', 'loads', 'copy', 'drifted', 'own', 'elsewhere', 'viaFolder']);

/**
 * A skill on one machine, at All machines: in how many of its homes it loads, whether one of them needs a look, and the
 * machine's row for it, whose homes the cell opens to.
 */
export type FleetSkillCell = { loads: number; homes: number; look: boolean; row: SkillRow };
export type FleetSkillRow = { name: string; source: string | null; cells: Record<string, FleetSkillCell | null> };
export type FleetSkills = { machines: string[]; rows: FleetSkillRow[]; views: Record<string, SkillsView> };

/** Every skill any read machine has, and how it stands on each: Sync › Skills at All machines. */
export function fleetSkills(machines: SetupMachine[]): FleetSkills {
  // A machine not read yet has nothing to say, as the Skills page on it says.
  const read = machines.filter((machine) => machine.scannedAt !== null || machine.homes.length > 0);
  const views = read.map((machine) => [machine.machine, skillsView(machine)] as const);
  const names = [...new Set(views.flatMap(([, view]) => view.rows.map((row) => row.name)))].sort((a, b) => a.localeCompare(b));
  const rows = names.map((name): FleetSkillRow => {
    const cells: Record<string, FleetSkillCell | null> = {};
    let source: string | null = null;
    for (const [machine, view] of views) {
      const row = view.rows.find((entry) => entry.name === name);
      source ??= row?.source ?? null;
      cells[machine] = row && (row.store || row.cells.some((cell) => cell.place !== 'none'))
        ? { loads: row.cells.filter((cell) => LOADING.has(cell.place) && !isTurnedOff(cell)).length, homes: row.cells.length, look: needsLook(row), row }
        : null;
    }
    return { name, source, cells };
  });
  return { machines: views.map(([machine]) => machine), rows, views: Object.fromEntries(views) };
}

/** How a skill stands on a machine, for telling machines apart: not there, loading somewhere, or there but loading nowhere. */
const fleetState = (cell: FleetSkillCell | null | undefined) => (!cell ? 'none' : cell.loads ? 'loads' : 'off');

/**
 * Whether a skill wants a look at All machines: a home somewhere needs one, a change is chosen for it, or the machines
 * don't all have it the same way.
 */
export function fleetNeedsLook(row: FleetSkillRow, machines: string[], chosen: Record<string, PendingSkills>, removed: ReadonlySet<string> = new Set()): boolean {
  if (machines.some((machine) => row.cells[machine]?.look)) return true;
  if (removed.has(row.name) && machines.some((machine) => row.cells[machine])) return true;
  if (machines.some((machine) => Object.keys(chosen[machine] ?? {}).some((key) => key.endsWith(`\u0000${row.name}`)))) return true;
  return new Set(machines.map((machine) => fleetState(row.cells[machine]))).size > 1;
}

/** The rows the fleet table shows, the ones wanting a look first, and only those when `onlyLook` is on. */
export function fleetSkillGrid(
  fleet: FleetSkills,
  onlyLook: boolean,
  query: string,
  chosen: Record<string, PendingSkills>,
  removed: ReadonlySet<string> = new Set(),
): { rows: FleetSkillRow[]; inLine: number } {
  const text = query.trim().toLowerCase();
  const found = fleet.rows.filter((row) => !text || row.name.toLowerCase().includes(text) || Boolean(row.source?.toLowerCase().includes(text)));
  const look = found.filter((row) => fleetNeedsLook(row, fleet.machines, chosen, removed));
  return onlyLook
    ? { rows: look, inLine: found.length - look.length }
    : { rows: [...look, ...found.filter((row) => !look.includes(row))], inLine: 0 };
}

/**
 * What taking a skill the repo removed off one machine chooses: every home's link or copy goes. The store's own copy
 * isn't a home's to remove; the machine's repo review removes it, and a link left behind shows as leading nowhere.
 */
export function removeFromMachine(cell: FleetSkillCell, pending: PendingSkills = {}): PlannedSkill[] {
  return cell.row.cells.flatMap((home) =>
    !pending[changeKey(home.home.path, cell.row.name)] && cellOptions(cell.row, home, pending).includes('remove')
      ? [{ row: cell.row, cell: home, action: 'remove' as const }]
      : [],
  );
}

/** How the repo has a skill: synced to every machine, taken off them all, or not in it. */
export type RepoSkillState = 'synced' | 'removed' | 'absent';
export const repoSkillState = (repo: Pick<SetupRepo, 'skills' | 'removedSkills'>, name: string): RepoSkillState =>
  repo.skills.some((skill) => skill.name === name) ? 'synced' : repo.removedSkills.includes(name) ? 'removed' : 'absent';

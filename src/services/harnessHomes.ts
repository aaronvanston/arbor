import { placeState } from './setupSkills';
import type { Harness, SetupItem, SetupMachine, SkillAction, SkillChange } from '../native/types';

/**
 * The other harnesses' homes (Pi's, Droid's, OpenCode's…) as the setup scan reads them: their own instructions file,
 * the skills in their own folder, their MCP servers and, for one that keeps them in a file, their hooks. Every one of them loads the machine's store (~/.agents/skills) itself,
 * as Codex does, so a skill of its own can move into the store, or go when the store has it.
 */

/** The catalog's order, so each harness lists in the same place everywhere. */
const ORDER: readonly Harness[] = ['claude', 'codex', 'pi', 'primeAgent', 'openCode', 'droid', 'amp', 'gemini', 'other'];
const byHarness = (a: Harness, b: Harness) => ORDER.indexOf(a) - ORDER.indexOf(b);

/**
 * How a home's instructions file stands against the same harness's on the other machines: the same everywhere it's
 * set, different somewhere, set on this machine alone, or not set here.
 */
export type InstructionsState = 'same' | 'differs' | 'only' | 'missing';

export type HarnessHomeRow = {
  machine: string;
  harness: Harness;
  /** With the machine's home as ~. */
  path: string;
  /** Its own instructions file, when it has one. */
  instructions: SetupItem | null;
  state: InstructionsState;
  /** The skills in its own folder. */
  skills: number;
  /** The version of the harness that runs on the machine, when the scan found it. */
  version: string | null;
};

const ownInstructions = (items: SetupItem[]) => items.find((item) => item.kind === 'instructions' && item.sum !== null) ?? null;

/** Every other harness's home on every machine, by harness and then machine. */
export function harnessHomeRows(machines: SetupMachine[]): HarnessHomeRow[] {
  const homes = machines.flatMap((entry) => entry.harnessHomes.map((home) => ({ machine: entry.machine, home })));
  const sums = new Map<Harness, string[]>();
  for (const { home } of homes) {
    const sum = ownInstructions(home.items)?.sum;
    if (sum) sums.set(home.harness, [...(sums.get(home.harness) ?? []), sum]);
  }
  return homes
    .map(({ machine, home }): HarnessHomeRow => {
      const instructions = ownInstructions(home.items);
      const all = sums.get(home.harness) ?? [];
      const state: InstructionsState = !instructions ? 'missing' : all.length === 1 ? 'only' : new Set(all).size === 1 ? 'same' : 'differs';
      const version = machines.find((entry) => entry.machine === machine)?.harnessInstalls.find((install) => install.harness === home.harness)?.version ?? null;
      return { machine, harness: home.harness, path: home.path, instructions, state, skills: home.items.filter((item) => item.kind === 'skill').length, version };
    })
    .sort((a, b) => byHarness(a.harness, b.harness) || a.machine.localeCompare(b.machine) || a.path.localeCompare(b.path));
}

/**
 * How a harness's own copy of a skill stands against the machine's store: only it has one, the store's is the same or
 * differs, or it's a link (to the store or elsewhere), which is only ever removed.
 */
export type HarnessSkillStanding = 'own' | 'sameAsStore' | 'differs' | 'link';

export type HarnessSkillPlace = {
  harness: Harness;
  /** The home, as the scan names it. */
  home: string;
  item: SetupItem;
  /** The store's copy on the same machine, when it has one. */
  store: SetupItem | null;
  standing: HarnessSkillStanding;
  /** What can be done with it: none when the home's skills folder is a link, as then they're that folder's. */
  actions: SkillAction[];
};

export type HarnessSkillRow = {
  name: string;
  /** Where each machine has it, by machine, in the catalog's order. */
  on: Record<string, HarnessSkillPlace[]>;
};

const storeSkill = (machine: SetupMachine, name: string) =>
  machine.homes.find((home) => home.agent === 'shared')?.items.find((item) => item.kind === 'skill' && item.name === name) ?? null;

function standing(item: SetupItem, store: SetupItem | null): HarnessSkillStanding {
  if (item.link !== null || item.sum === null) return 'link';
  if (!store || store.sum === null) return 'own';
  return store.link === null && store.sum === item.sum ? 'sameAsStore' : 'differs';
}

/** What the store's state lets a harness's own copy do: move in where the store has none or its own differs, and go. */
function actionsFor(place: HarnessSkillStanding, store: SetupItem | null): SkillAction[] {
  if (place === 'link') return ['remove'];
  // The store's own link to a skill isn't put aside for another.
  if (store?.link) return ['remove'];
  return place === 'sameAsStore' ? ['remove'] : ['adopt', 'remove'];
}

/** Every skill in another harness's own folder, by name, with where each machine has it. */
export function harnessSkillRows(machines: SetupMachine[]): HarnessSkillRow[] {
  const rows = new Map<string, HarnessSkillRow>();
  for (const entry of machines) {
    for (const home of entry.harnessHomes) {
      for (const item of home.items.filter((found) => found.kind === 'skill')) {
        const row = rows.get(item.name) ?? { name: item.name, on: {} };
        const store = storeSkill(entry, item.name);
        const stands = standing(item, store);
        const place: HarnessSkillPlace = {
          harness: home.harness, home: home.path, item, store, standing: stands, actions: home.skillsLink ? [] : actionsFor(stands, store),
        };
        row.on[entry.machine] = [...(row.on[entry.machine] ?? []), place].sort((a, b) => byHarness(a.harness, b.harness));
        rows.set(item.name, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The change an action makes to a harness's copy, against what the last scan found there and in the store. */
export function harnessSkillChange(name: string, place: HarnessSkillPlace, action: SkillAction): SkillChange | null {
  const homeBefore = placeState(place.item);
  const storeBefore = placeState(place.store);
  if (homeBefore === null || storeBefore === null || !place.actions.includes(action)) return null;
  return { home: place.home, name, action, homeBefore, storeBefore };
}

/** How a harness's server or hook stands against the same harness's of the same name on the other machines. */
export type HarnessItemState = 'same' | 'differs' | 'only';

export type HarnessItemPlace = {
  harness: Harness;
  /** The home, as the scan names it. */
  home: string;
  item: SetupItem;
  state: HarnessItemState;
};

export type HarnessItemRow = {
  name: string;
  /** Where each machine has it, by machine, in the catalog's order. */
  on: Record<string, HarnessItemPlace[]>;
};

/** Every MCP server or hook in another harness's home, by name, with where each machine has it. */
export function harnessItemRows(machines: SetupMachine[], kind: 'mcp' | 'hook'): HarnessItemRow[] {
  const found = machines.flatMap((entry) =>
    entry.harnessHomes.flatMap((home) => home.items.filter((item) => item.kind === kind).map((item) => ({ machine: entry.machine, home, item }))));
  const sums = new Map<string, (string | null)[]>();
  const key = (harness: Harness, name: string) => `${harness}\t${name}`;
  for (const { home, item } of found) sums.set(key(home.harness, item.name), [...(sums.get(key(home.harness, item.name)) ?? []), item.sum]);
  const rows = new Map<string, HarnessItemRow>();
  for (const { machine, home, item } of found) {
    const all = sums.get(key(home.harness, item.name)) ?? [];
    const state: HarnessItemState = all.length === 1 ? 'only' : new Set(all).size === 1 ? 'same' : 'differs';
    const row = rows.get(item.name) ?? { name: item.name, on: {} };
    row.on[machine] = [...(row.on[machine] ?? []), { harness: home.harness, home: home.path, item, state }].sort((a, b) => byHarness(a.harness, b.harness));
    rows.set(item.name, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

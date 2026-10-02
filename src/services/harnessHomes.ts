import type { Harness, SetupItem, SetupMachine } from '../native/types';

/**
 * The other harnesses' homes (Pi's, Droid's, OpenCode's…) as the setup scan reads them: their own instructions file and
 * the skills in their own folder, nothing else. Sync shows them; nothing here changes them yet.
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
      return { machine, harness: home.harness, path: home.path, instructions, state, skills: home.items.filter((item) => item.kind === 'skill').length };
    })
    .sort((a, b) => byHarness(a.harness, b.harness) || a.machine.localeCompare(b.machine) || a.path.localeCompare(b.path));
}

export type HarnessSkillRow = {
  name: string;
  /** The harnesses each machine has it in, by machine. */
  on: Record<string, Harness[]>;
};

/** Every skill in another harness's own folder, by name, with where each machine has it. */
export function harnessSkillRows(machines: SetupMachine[]): HarnessSkillRow[] {
  const rows = new Map<string, HarnessSkillRow>();
  for (const entry of machines) {
    for (const home of entry.harnessHomes) {
      for (const item of home.items.filter((found) => found.kind === 'skill')) {
        const row = rows.get(item.name) ?? { name: item.name, on: {} };
        const listed = row.on[entry.machine] ?? [];
        if (!listed.includes(home.harness)) row.on[entry.machine] = [...listed, home.harness].sort(byHarness);
        rows.set(item.name, row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

import type { MessageKey } from '../i18n/resources';
import type { LibraryRow } from './library';
import { bringInLine, type LineRun, type SwitchSources } from './libraryToggle';
import { takeMcpServer } from './setupMcp';
import { setSetupCodexPlugin, setSetupPlugin } from './setupPluginRepo';
import { setSetupFileMachine, setSetupSkillMachine, takeSetupFile, takeSetupSkills } from './setupSync';
import type { SetupMachine } from '../native/types';

/**
 * A machine's own edit to something the repo keeps, found by Sync's base (`setup_standing.rs`): Arbor never brings
 * it in line by itself. The user picks one of three:
 * - `take`: the machine's copy becomes the repo's, for every machine;
 * - `keep`: the machine keeps its copy as its own value in the repo, and the rest follow the repo;
 * - `useRepo`: the repo's replaces it there, backed up first so Undo puts the edit back.
 */
export type Decision = 'take' | 'keep' | 'useRepo';

/** What a kind can't do, and why, so the row can say so instead of offering it. */
export type DecisionOffer = { decision: Decision; unavailable: MessageKey | null };

/**
 * The decisions a row offers. A hook is one definition for every machine with no machine copy to keep, and taking it
 * in wouldn't take an edited script, so only the repo's can be used; a plugin has nothing to take in, only a value.
 */
export function decisionsFor(row: LibraryRow): DecisionOffer[] {
  const take: MessageKey | null = row.kind === 'hooks' ? 'edited.unavailable.takeHook'
    : row.kind === 'plugins' ? 'edited.unavailable.takePlugin'
      : row.kind === 'instructions' && !row.detail ? 'edited.unavailable.takeFile' : null;
  const keep: MessageKey | null = row.kind === 'hooks' ? 'edited.unavailable.keepHook'
    : row.kind === 'plugins' && row.toggle?.kind !== 'plugin' ? 'edited.unavailable.keepPlugin' : null;
  return [
    { decision: 'take', unavailable: take },
    { decision: 'keep', unavailable: keep },
    { decision: 'useRepo', unavailable: null },
  ];
}

/** The home a machine has a row in, for the kinds taken from one home. */
const homeOf = (row: LibraryRow, machine: string) => row.places[machine]?.homes.find((home) => home !== '~/.agents') ?? null;

/** What a decision changed: the repo's sources read back, and for the repo's copy, what was backed up for Undo. */
export type DecisionRun = SwitchSources & { run: LineRun | null };

/** Carries out one decision on one machine's edit. */
export async function decide(repo: string, sources: { [K in keyof SwitchSources]-?: SwitchSources[K] | null }, machines: SetupMachine[], row: LibraryRow, machine: string, decision: Decision): Promise<DecisionRun> {
  const unavailable = decisionsFor(row).find((offer) => offer.decision === decision)?.unavailable;
  if (unavailable) throw new Error(`${row.name} can't be decided that way here`);
  if (decision === 'useRepo') {
    // The one row on the one machine, the edit included: the user chose it.
    const run = await bringInLine(repo, sources, machines, { machine, rows: [row] });
    return { run };
  }
  const own = decision === 'keep';
  switch (row.kind) {
    case 'instructions': {
      const path = row.detail ?? '';
      return { repo: own ? await setSetupFileMachine(repo, path, machine, 'own') : await takeSetupFile(repo, machine, path), run: null };
    }
    case 'skills':
      return { repo: own ? await setSetupSkillMachine(repo, row.name, machine, 'own') : await takeSetupSkills(repo, machine, [`~/.agents/skills/${row.name}`]), run: null };
    case 'mcps': {
      const home = homeOf(row, machine);
      if (!home) throw new Error(`${machine} has no home with ${row.name}`);
      return { registry: await takeMcpServer(repo, machine, home, row.name, own), run: null };
    }
    case 'plugins': {
      if (row.toggle?.kind !== 'plugin') throw new Error(`${row.name} isn't a plugin the repo lists`);
      const set = row.toggle.codex ? setSetupCodexPlugin : setSetupPlugin;
      return { repo: await set(repo, row.toggle.row.id, null, machine, 'own'), run: null };
    }
    case 'hooks':
      throw new Error(`${row.name} can only take the repo's`);
  }
}

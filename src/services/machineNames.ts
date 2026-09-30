import { machineLookKey } from './machineLook';
import { savedStore, storedRecord } from './savedStore';

/**
 * The names machines are shown by in Arbor, when one was given here. A machine is still its own name everywhere Arbor
 * keeps or sends it (API-key assignments, SSH hosts, the setup repo, the archive, history), so a rename only changes
 * what's shown: it's instant, and nothing is moved or lost. Kept on this Mac, by the same loose key as a machine's look,
 * so "Mac Mini" and "mac-mini" are one machine here too.
 */
export type MachineNames = Readonly<Record<string, string>>;

/** Long enough for "Casey's MacBook Pro (work)", short enough for a pill in a table. */
export const MACHINE_NAME_MAX = 40;

/** A name as it's kept: trimmed, with runs of spaces made one, or null when there's nothing left or it's too long. */
function keptName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  return name && name.length <= MACHINE_NAME_MAX ? name : null;
}

function parseNames(raw: string | null): MachineNames {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(storedRecord(raw))) {
    const name = keptName(value);
    if (key && name) kept[key] = name;
  }
  return kept;
}

const store = savedStore<MachineNames>({ key: 'arbor.machine-names.v1', parse: parseNames, fallback: {} });
/** The names given here, for code outside React. */
export const getMachineNames = store.get;

export const useMachineNames = store.useValue;

/** The name a machine is shown by in `given`: the one given to it here, else its own. */
export const machineNameIn = (given: MachineNames, machine: string) => given[machineLookKey(machine)] ?? machine;

/** The name a machine is shown by, for code outside React. Components use `useMachineName` so they follow a rename. */
export const machineName = (machine: string) => machineNameIn(store.get(), machine);

export const useMachineName = (machine: string) => machineNameIn(useMachineNames(), machine);

/**
 * Names a machine. A blank name, or its own name exactly, takes it back to its own name, and a name past
 * `MACHINE_NAME_MAX` is refused (false). Whether another machine goes by it is the caller's to ask
 * (`machineNameTakenBy`), since only it knows which machines there are.
 */
export function setMachineName(machine: string, name: string): boolean {
  const key = machineLookKey(machine);
  if (!key) return false;
  const trimmed = name.trim().replace(/\s+/g, ' ');
  const kept = trimmed && trimmed !== machine ? keptName(trimmed) : null;
  if (trimmed && trimmed !== machine && !kept) return false;
  const names = store.get();
  if ((names[key] ?? null) === kept) return true;
  const { [key]: _previous, ...rest } = names;
  store.set(kept ? { ...rest, [key]: kept } : rest);
  return true;
}

/**
 * The machine among `machines` that `name` would be confused with, as it's shown, or null: one whose own name or shown
 * name reads the same, loosely. Its own names never count, so "macbook-air" can become "MacBook Air".
 */
export function machineNameTakenBy(machine: string, name: string, machines: Iterable<string>, given: MachineNames = store.get()): string | null {
  const wanted = machineLookKey(name);
  const self = machineLookKey(machine);
  if (!wanted) return null;
  for (const other of machines) {
    if (machineLookKey(other) === self) continue;
    const shown = machineNameIn(given, other);
    if (machineLookKey(other) === wanted || machineLookKey(shown) === wanted) return shown;
  }
  return null;
}

import { isIdentityFill, keptColor, type IdentityColor, type IdentityFill, type PickedColor } from './identityColors';
import type { MachineKind } from './machineIdentity';
import { savedStore, storedRecord } from './savedStore';

/** The shapes a machine's icon can be set to; unset, it's the one its model says. */
export const machineIconChoices: readonly MachineKind[] = ['laptop', 'macMini', 'macStudio', 'imac', 'macPro', 'mac', 'server'];

/** What was picked for a machine. Any of it can be left to its default. */
export type MachineLookChoice = { color?: PickedColor; icon?: MachineKind; fill?: IdentityFill };

/** Machine names compare as the backend compares them, so "Mac Mini" and "mac-mini" are one machine. */
export const machineLookKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const isColor = (value: unknown): value is PickedColor => keptColor(value) !== null;
const isIcon = (value: unknown): value is MachineKind => typeof value === 'string' && machineIconChoices.includes(value as MachineKind);

/** A choice with only what's set in it, or null when nothing is. */
function keptChoice(color: unknown, icon: unknown, fill: unknown): MachineLookChoice | null {
  const choice: MachineLookChoice = {};
  const kept = keptColor(color);
  if (kept) choice.color = kept;
  if (isIcon(icon)) choice.icon = icon;
  // Soft is what a pill is without a choice, so it isn't kept.
  if (isIdentityFill(fill) && fill !== 'soft') choice.fill = fill;
  return choice.color || choice.icon || choice.fill ? choice : null;
}

function parseChoices(raw: string | null): Record<string, MachineLookChoice> {
  const choices: Record<string, MachineLookChoice> = {};
  for (const [key, value] of Object.entries(storedRecord(raw))) {
    if (!value || typeof value !== 'object') continue;
    const { color, icon, fill } = value as Record<string, unknown>;
    const choice = keptChoice(color, icon, fill);
    if (choice) choices[key] = choice;
  }
  return choices;
}

const store = savedStore<Record<string, MachineLookChoice>>({ key: 'arbor.machine-looks.v1', parse: parseChoices, fallback: {} });

export const useMachineLookChoices = store.useValue;

/** Sets or clears (undefined) a machine's color, icon or fill. A value that isn't one leaves what was there. */
export function setMachineLook(name: string, patch: MachineLookChoice) {
  const key = machineLookKey(name);
  const valid: Record<keyof MachineLookChoice, (value: unknown) => boolean> = { color: isColor, icon: isIcon, fill: isIdentityFill };
  const kept = Object.entries(patch).filter(([field, value]) => value === undefined || valid[field as keyof MachineLookChoice]?.(value));
  const choices = store.get();
  const merged: MachineLookChoice = { ...choices[key], ...Object.fromEntries(kept) };
  const next = keptChoice(merged.color, merged.icon, merged.fill);
  const { [key]: _previous, ...rest } = choices;
  store.set(next ? { ...rest, [key]: next } : rest);
}

/**
 * Colors a machine gets by default: the ones it always had (sky round to pink), so a machine nobody picked for keeps
 * its color as the palette grows. Slate reads as no color and stays a choice.
 */
const DEFAULT_COLORS: readonly IdentityColor[] = ['sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink'];

/** The color a machine has until one is picked: the same for a name every time, spread over the palette. */
export function defaultMachineColor(name: string): IdentityColor {
  let hash = 0;
  for (const char of machineLookKey(name)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return DEFAULT_COLORS[hash % DEFAULT_COLORS.length]!;
}

export type MachineLook = { color: PickedColor; icon: MachineKind | null; fill: IdentityFill; picked: boolean };

/** A machine's look: what was picked, else its default color, the shape its model says (null if unknown) and soft. */
export function resolveMachineLook(name: string, choice: MachineLookChoice | undefined, kind: MachineKind | null | undefined): MachineLook {
  return {
    color: choice?.color ?? defaultMachineColor(name),
    icon: choice?.icon ?? kind ?? null,
    fill: choice?.fill ?? 'soft',
    picked: Boolean(choice?.color || choice?.icon || choice?.fill),
  };
}

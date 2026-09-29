import { invokeCommand } from '../native/commands';
import { machineLookKey } from './machineLook';
import { projectSettingsKey } from './machineSettings';
import { tracked } from './productAnalytics';
import type { Blocked, CheckoutChange, ProjectCheckout } from './projectCheckouts';
import type { CheckoutInstructionsChange, InstructionFile, RepoInstructions, SetupMachine } from '../native/types';

/**
 * A project's own instructions: the setup repo holds the text, for every machine and for one, and Arbor copies it into
 * each of the project's checkouts in the files the agents read beside the checked-in ones and Git ignores. Claude Code
 * gets CLAUDE.local.md, which imports AGENTS.md first where that's what the checkout would otherwise read; Codex gets
 * AGENTS.override.md, the checkout's AGENTS.md followed by the text, on machines that have Codex. Arbor's files say on
 * their first line which text they hold, so a scan tells whether a checkout is in step without reading them.
 */

export const INSTRUCTION_FILES: InstructionFile[] = ['claudeLocal', 'agentsOverride'];

export const instructionFileName = (file: InstructionFile) => (file === 'claudeLocal' ? 'CLAUDE.local.md' : 'AGENTS.override.md');

/** The project's text in the repo for every machine (`machine` null) or for one machine alone. */
export function repoText(list: RepoInstructions[], project: string, machine: string | null): RepoInstructions | null {
  const key = projectSettingsKey(project);
  const own = machine === null ? null : machineLookKey(machine);
  return list.find((entry) => entry.project === key && entry.machine === own) ?? null;
}

/** The text a project's checkouts on a machine get: the machine's own, else every machine's; null when there's none. */
export function textOn(list: RepoInstructions[], project: string, machine: string): { hash: string; own: boolean } | null {
  const own = repoText(list, project, machine);
  if (own) return { hash: own.hash, own: true };
  const all = repoText(list, project, null);
  return all ? { hash: all.hash, own: false } : null;
}

/** The projects that have instructions of their own in the repo. */
export const projectsWithText = (list: RepoInstructions[]) => [...new Set(list.map((entry) => entry.project))];

/** Whether a machine has Codex, so its checkouts get AGENTS.override.md too. */
export const hasCodex = (machines: SetupMachine[], machine: string) =>
  Boolean(machines.find((entry) => entry.machine === machine)?.homes.some((home) => home.agent === 'codex'));

/**
 * Every file the project's checkouts need written to hold the repo's text. A checkout Arbor never wrote to needs
 * nothing once the text is taken out; one it did gets its file emptied of it. A file that's someone's own, or one Git
 * would see, is left and says why.
 */
export function instructionChanges(list: RepoInstructions[], checkouts: ProjectCheckout[], project: string, codex: (machine: string) => boolean): CheckoutChange[] {
  return checkouts.flatMap((checkout) => {
    const wanted = textOn(list, project, checkout.machine)?.hash ?? '-';
    return INSTRUCTION_FILES.filter((file) => file === 'claudeLocal' || codex(checkout.machine)).flatMap((file): CheckoutChange[] => {
      const found = checkout.instructions.find((entry) => entry.file === file);
      if (!found) return [];
      if (wanted === '-' && found.state !== 'arbor') return [];
      const inStep = found.state === 'arbor' && found.text === wanted && (file === 'claudeLocal'
        ? found.import === (Boolean(checkout.agentsMd) && !checkout.claudeMd)
        : found.agents === (checkout.agentsMd ?? '-'));
      if (inStep) return [];
      const blocked: Blocked | null = found.state === 'own' ? 'own' : found.state === 'seen' ? 'seen' : null;
      return [{ machine: checkout.machine, checkout: checkout.path, target: file, on: wanted !== '-', blocked }];
    });
  });
}

/** A machine's ready changes as its apply_checkout_instructions takes them. */
export const instructionsChanges = (changes: CheckoutChange[]): CheckoutInstructionsChange[] =>
  changes.map((change) => ({ checkout: change.checkout, file: change.target as InstructionFile }));

/** The project's text for every machine (`machine` null) or one, as the repo's last commit has it. */
export const readProjectInstructions = (repo: string, project: string, machine: string | null) =>
  invokeCommand('read_setup_project_instructions', { repo, project, machine });

/** Saves the project's text for every machine or one, or with null takes it out; commits the one file. */
export const setProjectInstructions = (repo: string, project: string, machine: string | null, text: string | null) =>
  invokeCommand('set_setup_project_instructions', { repo, project, machine, text });

/** Writes the project's text from the repo into its checkouts on a machine. */
export const applyCheckoutInstructions = (repo: string, project: string, machine: string, changes: CheckoutInstructionsChange[]) =>
  tracked('sync-applied', invokeCommand('apply_checkout_instructions', { repo, project, machine, changes }), { kind: 'instructions', count: changes.length });

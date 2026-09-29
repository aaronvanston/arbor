import { invokeCommand } from '../native/commands';
import { tracked } from './productAnalytics';
import { projectValueAt, type Blocked, type CheckoutChange, type ProjectCheckout } from './projectCheckouts';
import type { CheckoutSkillChange, OverrideState, RepoProjectValue, SetupMachine } from '../native/types';

/**
 * A project's skills: the setup repo gives a skill a value for a project, and Arbor brings each of the project's
 * checkouts in step by setting it in the checkout's own skillOverrides, in its git-ignored .claude/settings.local.json.
 */

/** The home whose skills a checkout's sessions load: Claude Code's default one. */
const CHECKOUT_HOME = '~/.claude';

/** How a machine's Claude Code home has a skill: whether it's there, and what its settings and the policy make of it. */
export type HomeSkill = { installed: boolean; state: OverrideState | null; policy: OverrideState | null };

export function homeSkill(machines: SetupMachine[], machine: string, skill: string): HomeSkill {
  const home = machines.find((entry) => entry.machine === machine)?.homes.find((entry) => entry.agent === 'claude' && entry.path === CHECKOUT_HOME);
  const overrides = home?.skillOverrides.filter((entry) => entry.name === skill) ?? [];
  return {
    installed: Boolean(home?.items.some((item) => item.kind === 'skill' && item.name === skill)),
    state: overrides.find((entry) => entry.source === 'settings')?.state ?? null,
    policy: overrides.find((entry) => entry.source === 'policy')?.state ?? null,
  };
}

/**
 * Whether a skill loads in a checkout, as Claude Code decides: the machine's policy over everything, then the
 * checkout's local settings, its checked-in settings, then the home's. Offered by name only still loads; a skill
 * that isn't there never does.
 */
export function skillLoadsIn(checkout: ProjectCheckout, skill: string, home: HomeSkill): { on: boolean; from: 'policy' | 'local' | 'shared' | 'home' } {
  const local = checkout.skills.find((entry) => entry.local && entry.name === skill);
  const shared = checkout.skills.find((entry) => !entry.local && entry.name === skill);
  const from = home.policy ? 'policy' : local ? 'local' : shared ? 'shared' : 'home';
  const state = home.policy ?? local?.state ?? shared?.state ?? home.state;
  return { on: home.installed && state !== 'off', from };
}

/** Every change that brings the project's checkouts in step with the repo, a skill at a time. */
export function projectSkillChanges(
  skills: string[],
  values: Record<string, Record<string, RepoProjectValue>>,
  checkouts: ProjectCheckout[],
  project: string,
  home: (machine: string, skill: string) => HomeSkill,
): CheckoutChange[] {
  return skills.flatMap((skill) =>
    checkouts.flatMap((checkout): CheckoutChange[] => {
      const wanted = projectValueAt(values[skill] ?? {}, project, checkout.machine);
      if (!wanted) return [];
      const here = home(checkout.machine, skill);
      const on = skillLoadsIn(checkout, skill, here).on;
      if ((wanted.value === 'on') === on) return [];
      const ignored = checkout.ignoredOverrides.includes('settings.local.json');
      let blocked: Blocked | null = null;
      if (here.policy) blocked = 'policy';
      else if (wanted.value === 'on' && !here.installed) blocked = 'notInstalled';
      else if (ignored) blocked = 'ignored';
      else if (checkout.localSeen) blocked = 'seen';
      return [{ machine: checkout.machine, checkout: checkout.path, target: skill, on: wanted.value === 'on', blocked }];
    }),
  );
}

/** A machine's ready changes as its apply_checkout_skills takes them. */
export const skillChanges = (changes: CheckoutChange[]): CheckoutSkillChange[] =>
  changes.map((change) => ({ checkout: change.checkout, skill: change.target, on: change.on }));

/** Gives a project a value for a skill on every machine or on one, or with null lets it follow its machine; commits the one file. */
export const setSetupSkillProject = (repo: string, skill: string, project: string, machine: string | null, wanted: 'on' | 'off' | null) =>
  invokeCommand('set_setup_skill_project', { repo, skill, project, machine, wanted });

/** Sets skills on or off in checkouts on a machine, each in its own settings.local.json. */
export const applyCheckoutSkills = (machine: string, changes: CheckoutSkillChange[]) =>
  tracked('skills-changed', invokeCommand('apply_checkout_skills', { machine, changes }), { kind: 'checkouts', count: changes.length });

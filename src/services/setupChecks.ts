import { invokeCommand } from '../native/commands';
import { homeKey, policySets, turnedOff } from './setupInventory';
import type { SetupHome, SetupItem, SetupMachine, SkillOverride } from '../native/types';

/**
 * Checks on what the agents load on each machine, worked out from the last scan: things an agent
 * can't load or won't start with, things likely to bite, and things worth knowing. Nothing more is
 * read from any machine to make them.
 *
 * What each agent does was checked against Claude Code 2.1.282's docs and Codex 0.157's docs and
 * source.
 */

/** `problem`: an agent can't load something it's pointed at, or won't start. `warning`: likely to bite. `note`: worth knowing. */
export type SetupCheckLevel = 'problem' | 'warning' | 'note';

export type SetupCheckKind =
  | 'scanFailed'
  | 'unreadable'
  | 'policyUnreadable'
  | 'sessionCleanup'
  | 'brokenImport'
  | 'deepImport'
  | 'brokenLink'
  | 'tooLarge'
  | 'skillNoDoc'
  | 'skillNoDescription'
  | 'skillLongName'
  | 'skillNameMismatch'
  | 'skillDuplicate'
  | 'skillDrifted'
  | 'codexUnsupported'
  | 'codexDeprecated'
  | 'codexSkillsFolder'
  | 'overridesIgnored'
  | 'noSkills'
  | 'listingBudget'
  | 'toolSearchOff'
  | 'policySets'
  | 'duplicateInstall';

/** Two copies of a skill on one machine, in different homes. */
export type SetupPair = { a: { home: string; item: SetupItem }; b: { home: string; item: SetupItem } };

/** What a check is about: a row in a home's table, or an install. */
export type SetupCheckSubject = {
  /** As the home's table names it, or an install's path. */
  name: string;
  /**
   * A fact to show beside it: where it links, the file that imports it, the name it gives itself,
   * an install's version, or for an old Codex setting what takes its place.
   */
  value: string | null;
  /** The home whose table has it as a row. */
  home: string | null;
  /** Its two copies, when comparing them is what there is to see. */
  pair: SetupPair | null;
};

export type SetupCheck = {
  /** The same for the same finding from one scan to the next. */
  id: string;
  kind: SetupCheckKind;
  level: SetupCheckLevel;
  machine: string;
  /** The home it's about, or null for the machine as a whole. */
  home: string | null;
  subjects: SetupCheckSubject[];
  /** What its message needs: which agent, an error, a count. */
  facts: Record<string, string | number>;
};

const LEVEL: Record<SetupCheckKind, SetupCheckLevel> = {
  scanFailed: 'warning',
  unreadable: 'warning',
  policyUnreadable: 'warning',
  sessionCleanup: 'warning',
  brokenImport: 'problem',
  deepImport: 'problem',
  brokenLink: 'problem',
  tooLarge: 'problem',
  skillNoDoc: 'warning',
  skillNoDescription: 'problem',
  skillLongName: 'problem',
  skillNameMismatch: 'note',
  skillDuplicate: 'warning',
  skillDrifted: 'warning',
  codexUnsupported: 'problem',
  codexDeprecated: 'warning',
  codexSkillsFolder: 'note',
  overridesIgnored: 'warning',
  noSkills: 'note',
  listingBudget: 'note',
  toolSearchOff: 'note',
  policySets: 'note',
  duplicateInstall: 'warning',
};

/** The order a machine's checks of one level are listed in. */
const KIND_ORDER = Object.keys(LEVEL) as SetupCheckKind[];
const LEVEL_ORDER: Record<SetupCheckLevel, number> = { problem: 0, warning: 1, note: 2 };

export const AGENT_NAME = { claude: 'Claude Code', codex: 'Codex' } as const;

/** Claude Code deletes sessions nobody has touched for this many days when its home doesn't set cleanupPeriodDays. */
export const CLEANUP_DEFAULT_DAYS = 30;
/** A home that keeps sessions at least this long is left alone. Arbor's fix uses the same line. */
export const KEEP_AT_LEAST_DAYS = 3_650;
/** What keeping a home's sessions sets cleanupPeriodDays to. */
export const KEEP_DAYS = 36_500;

/** Sets cleanupPeriodDays in these Claude Code homes on a machine, then scans it again. */
export const keepClaudeSessions = (machine: string, homes: string[]) => invokeCommand('keep_claude_sessions', { machine, homes });

/**
 * How many days Claude Code keeps an untouched session in a home, as its settings.json has it, or
 * null when that's long enough. 0 once turned saving off altogether, and Claude Code refuses a
 * setting that isn't a whole number, so both go by the default.
 */
export function cleanupDays(items: SetupItem[]): number | null {
  const setting = items.find((item) => item.kind === 'setting' && item.name === 'cleanupPeriodDays');
  const set = setting?.value != null && /^\d+$/.test(setting.value) ? Number(setting.value) : null;
  const days = set === null || set === 0 ? CLEANUP_DEFAULT_DAYS : set;
  return days < KEEP_AT_LEAST_DAYS ? days : null;
}

/** Claude Code follows @imports this many hops from the file that has the first. */
export const IMPORT_HOPS = 4;
/** Claude Code skips an instructions file or rule bigger than this. */
export const INSTRUCTIONS_MAX_BYTES = 4 * 1024 * 1024;
/** Codex won't load a skill whose name is longer than this. */
export const SKILL_NAME_MAX = 64;
/** Claude Code cuts each skill's description and when_to_use to this many characters in its listing. */
export const LISTING_ENTRY_MAX = 1_536;
/** Claude Code's budget for its skill listing when it can't tell how big the model's context window is. */
export const LISTING_FALLBACK_CHARS = 8_000;

/**
 * Codex settings its current versions no longer read, and what takes each one's place: a setting's
 * new name, or a word the page explains. The first two can stop Codex from starting.
 */
const CODEX_RETIRED: { name: string; value?: string; unsupported?: true; instead: string }[] = [
  { name: 'profile', unsupported: true, instead: 'profileFlag' },
  { name: 'approval_policy', value: 'untrusted', unsupported: true, instead: 'untrusted' },
  { name: 'profiles', instead: 'profileFiles' },
  { name: 'approval_policy', value: 'on-failure', instead: 'onFailure' },
  { name: 'experimental_instructions_file', instead: 'model_instructions_file' },
  { name: 'experimental_use_unified_exec_tool', instead: 'features.unified_exec' },
  { name: 'features.codex_hooks', instead: 'features.hooks' },
  { name: 'features.web_search', instead: 'web_search' },
  { name: 'features.web_search_cached', instead: 'web_search' },
  { name: 'features.web_search_request', instead: 'web_search' },
  { name: 'agents.max_threads', instead: 'agents.max_concurrent_threads_per_session' },
];

/** The agent that loads what's in a home. Codex reads the shared skills; Claude Code only reads them through a link. */
export const homeAgent = (home: Pick<SetupHome, 'agent'>) => (home.agent === 'claude' ? 'claude' : 'codex');

/** What's wrong with a copy on its own, whatever it's compared with. */
export function itemProblem(item: SetupItem): 'notFound' | 'brokenLink' | 'noSkillDoc' | null {
  if (item.kind === 'import' && item.sum === null) return 'notFound';
  if (item.kind === 'skill' && item.skill && !item.skill.hasDoc) return 'noSkillDoc';
  if (item.link !== null && item.sum === null) return 'brokenLink';
  return null;
}

/** The name an agent calls a skill by: Claude Code goes by its folder, Codex by its front matter. */
const codexName = (item: SetupItem) => item.skill?.declaredName ?? item.name;

/**
 * About how many characters Claude Code's skill listing takes for a home's skills: each name, with
 * its description and when_to_use up to the cap, leaving out skills only a person can invoke.
 * Plugins' and Claude Code's own skills aren't counted, and a skill without a description, which
 * is listed with the first line of its instructions, is counted by its name alone. Codex cuts each
 * entry shorter, so it passes its own `entryMax`. A Claude Code home's `overrides` leave out the
 * skills they turn off or keep from the model, and list name-only ones by their name alone.
 */
export function listingChars(items: SetupItem[], entryMax = LISTING_ENTRY_MAX, overrides: SkillOverride[] = []): number {
  const states = new Map(overrides.map((entry) => [entry.name, entry.state]));
  let total = 0;
  for (const item of items) {
    const skill = item.skill;
    const state = states.get(item.name);
    if (item.kind !== 'skill' || !skill?.hasDoc || skill.manualOnly || state === 'off' || state === 'userInvocableOnly') continue;
    // "- name: description\n"
    const described = state === 'nameOnly' ? 0 : Math.min(skill.descriptionChars + skill.whenToUseChars, entryMax);
    total += item.name.length + described + 4;
  }
  return total;
}

const rowSubject = (item: SetupItem, home: string, value: string | null = null): SetupCheckSubject => ({ name: item.name, value, home, pair: null });

/** The skills in a home that Codex loads, each with the home it's in. */
const homeSkills = (items: SetupItem[], home: string | null) =>
  home ? items.filter((item) => item.kind === 'skill' && item.skill?.hasDoc).map((item) => ({ item, home })) : [];

/**
 * Skills Codex would know by one name, where at least one is in `home`: each shown by its folder,
 * with the name it shares when that's another.
 */
function sameNames(skills: { item: SetupItem; home: string }[], home: string): SetupCheckSubject[] {
  const byName = new Map<string, typeof skills>();
  for (const entry of skills) byName.set(codexName(entry.item), [...(byName.get(codexName(entry.item)) ?? []), entry]);
  return [...byName.entries()]
    .filter(([, entries]) => entries.length > 1 && entries.some((entry) => entry.home === home))
    .flatMap(([name, entries]) => entries.map(({ item, home: where }) => ({ name: item.name, value: item.name === name ? null : name, home: where, pair: null })));
}

/** Every check on every machine scanned, problems first, then by machine in the order given. */
export function setupChecks(machines: SetupMachine[]): SetupCheck[] {
  const checks: SetupCheck[] = [];
  machines.forEach((machine) => {
    const add = (kind: SetupCheckKind, home: string | null, subjects: SetupCheckSubject[], facts: Record<string, string | number> = {}) => {
      checks.push({
        id: [machine.machine, home ?? '', kind, facts.problem ?? facts.agent ?? ''].join('\u0000'),
        kind,
        level: LEVEL[kind],
        machine: machine.machine,
        home,
        subjects,
        facts,
      });
    };
    /** Adds a check about things, when there are any. */
    const addAbout = (kind: SetupCheckKind, home: string | null, subjects: SetupCheckSubject[], facts: Record<string, string | number> = {}) => {
      if (subjects.length) add(kind, home, subjects, facts);
    };

    if (machine.error) add('scanFailed', null, [], { error: machine.error });

    // The policy applies to every Claude Code home here, so what it sets opens on the default home's rows.
    const policy = machine.policy;
    const claudeHome = machine.homes.find((home) => home.agent === 'claude' && home.path === '~/.claude') ?? machine.homes.find((home) => home.agent === 'claude');
    if (policy?.problem) add('policyUnreadable', null, [], { problem: policy.problem });
    if (policy?.ignoredOverrides) add('overridesIgnored', null, [], { problem: policy.file, file: policy.file });
    if (policy?.keys.length) {
      const at = claudeHome ? homeKey(claudeHome) : null;
      add('policySets', null, policy.keys.map((key) => ({ name: key.name, value: null, home: at, pair: null })), { file: policy.file, count: policy.keys.length });
    }

    const shared = machine.homes.find((home) => home.agent === 'shared') ?? null;
    const sharedKey = shared ? homeKey(shared) : null;
    const sharedSkills = (shared?.items ?? []).filter((item) => item.kind === 'skill');
    const defaultClaude = machine.homes.find((home) => home.agent === 'claude' && home.path === '~/.claude') ?? null;

    for (const home of machine.homes) {
      const key = homeKey(home);
      const agentId = homeAgent(home);
      const agent = AGENT_NAME[agentId];
      const items = home.items;
      const skills = items.filter((item) => item.kind === 'skill' && item.skill);
      const loaded = skills.filter((item) => item.skill!.hasDoc);

      for (const problem of home.problems) add('unreadable', key, [], { problem });
      for (const file of home.ignoredOverrides) add('overridesIgnored', key, [], { problem: file, file });

      const imports = items.filter((item) => item.kind === 'import' && item.import);
      const deep = (item: SetupItem) => item.import!.level > IMPORT_HOPS;
      addAbout('brokenImport', key, imports.filter((item) => !deep(item) && item.sum === null).map((item) => rowSubject(item, key, item.import!.from)));
      addAbout('deepImport', key, imports.filter(deep).map((item) => rowSubject(item, key, item.import!.from)), { hops: IMPORT_HOPS });
      addAbout('brokenLink', key, items.filter((item) => itemProblem(item) === 'brokenLink').map((item) => rowSubject(item, key, item.link)), { agent });

      if (agentId === 'claude') {
        addAbout(
          'tooLarge',
          key,
          items.filter((item) => (item.kind === 'instructions' || item.kind === 'rule') && (item.size ?? 0) > INSTRUCTIONS_MAX_BYTES).map((item) => rowSubject(item, key)),
        );
        // Codex looks inside a folder without one for skills further down, so only Claude Code's homes are checked.
        addAbout('skillNoDoc', key, skills.filter((item) => !item.skill!.hasDoc).map((item) => rowSubject(item, key, item.link)), { home: home.path });
      } else {
        addAbout('skillNoDescription', key, loaded.filter((item) => !item.skill!.descriptionChars).map((item) => rowSubject(item, key)));
        addAbout('skillLongName', key, loaded.filter((item) => codexName(item).length > SKILL_NAME_MAX).map((item) => rowSubject(item, key)), { max: SKILL_NAME_MAX });
      }
      addAbout(
        'skillNameMismatch',
        key,
        loaded.filter((item) => item.skill!.declaredName !== null && item.skill!.declaredName !== item.name).map((item) => rowSubject(item, key, item.skill!.declaredName)),
        { agent, agentId },
      );

      if (home.agent === 'codex') {
        // Codex reads its home's skills and the machine's shared ones. Two of this home's sharing a
        // name with each other or a shared one are listed here; two shared ones, once for the machine.
        addAbout('skillDuplicate', key, sameNames([...homeSkills(loaded, key), ...homeSkills(sharedSkills, sharedKey)], key));

        const settings = items.filter((item) => item.kind === 'setting');
        const retired = CODEX_RETIRED.flatMap((rule) => {
          const setting = settings.find((item) => item.name === rule.name && (rule.value === undefined || item.value === rule.value));
          return setting ? [{ rule, subject: rowSubject(setting, key, rule.instead) }] : [];
        });
        addAbout('codexUnsupported', key, retired.filter(({ rule }) => rule.unsupported).map(({ subject }) => subject));
        addAbout('codexDeprecated', key, retired.filter(({ rule }) => !rule.unsupported).map(({ subject }) => subject));
        addAbout('codexSkillsFolder', key, items.filter((item) => item.kind === 'skill').map((item) => rowSubject(item, key)), { home: home.path });
      }

      if (home.agent === 'claude') {
        // What the policy sets for cleanupPeriodDays isn't read, and it isn't the home's to change.
        const days = policySets(machine, 'setting', 'cleanupPeriodDays') ? null : cleanupDays(items);
        if (days !== null) add('sessionCleanup', key, [], { count: days, home: home.path });

        // Claude Code reads personal skills from the home it runs with, not ~/.claude, when that's another.
        const theirs = defaultClaude && defaultClaude !== home ? defaultClaude.items.filter((item) => item.kind === 'skill' && item.skill?.hasDoc).length : 0;
        if (!skills.length && theirs) add('noSkills', key, [], { count: theirs });

        const chars = listingChars(items, LISTING_ENTRY_MAX, home.skillOverrides);
        if (chars > LISTING_FALLBACK_CHARS) add('listingBudget', key, [], { chars, fallback: LISTING_FALLBACK_CHARS });

        const env = new Set(items.filter((item) => item.kind === 'env').map((item) => item.name));
        const servers = items.filter((item) => item.kind === 'mcp').length;
        if (env.has('ANTHROPIC_BASE_URL') && !env.has('ENABLE_TOOL_SEARCH') && servers) add('toolSearchOff', key, [], { count: servers });

        // A Claude Code home's own copy of a skill the machine shares, that no longer matches it.
        if (sharedKey) {
          const drifted = home.items.flatMap((item) => {
            const theirs = sharedSkills.find((entry) => entry.name === item.name && entry.sum !== null);
            // A skill the home's settings turn off doesn't load, so its copy drifting doesn't matter.
            if (item.kind !== 'skill' || item.sum === null || !theirs || theirs.sum === item.sum || turnedOff(home, item.name)) return [];
            return [{ name: item.name, value: null, home: key, pair: { a: { home: sharedKey, item: theirs }, b: { home: key, item } } }];
          });
          addAbout('skillDrifted', key, drifted);
        }
      }
    }

    if (sharedKey && (machine.homes.some((home) => home.agent === 'codex') || machine.installs.some((install) => install.agent === 'codex'))) {
      addAbout('skillDuplicate', sharedKey, sameNames(homeSkills(sharedSkills, sharedKey), sharedKey));
    }

    for (const agent of ['claude', 'codex'] as const) {
      const installs = machine.installs.filter((install) => install.agent === agent);
      if (installs.length > 1) {
        add('duplicateInstall', null, installs.map((install) => ({ name: install.path, value: install.version, home: null, pair: null })), { agent: AGENT_NAME[agent] });
      }
    }
  });

  const machineOrder = new Map(machines.map((machine, index) => [machine.machine, index]));
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) =>
      LEVEL_ORDER[a.check.level] - LEVEL_ORDER[b.check.level]
      || machineOrder.get(a.check.machine)! - machineOrder.get(b.check.machine)!
      || KIND_ORDER.indexOf(a.check.kind) - KIND_ORDER.indexOf(b.check.kind)
      || a.index - b.index)
    .map(({ check }) => check);
}

/** How many checks there are of each level. */
export function checkCounts(checks: SetupCheck[]): Record<SetupCheckLevel, number> {
  const counts: Record<SetupCheckLevel, number> = { problem: 0, warning: 0, note: 0 };
  for (const check of checks) counts[check.level] += 1;
  return counts;
}

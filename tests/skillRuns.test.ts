import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import { mockCommands } from '../src/dev/mock/answers';
import {
  bulkHomeChanges,
  planSize,
  planSkills,
  putsOnly,
  runSkillPlan,
  runSucceeded,
  skillCopies,
  takeableSkills,
  tickRows,
  touchedSkills,
  undoSkillRun,
  undoSucceeded,
  type SkillPlan,
  type SkillRunProgress,
} from '../src/services/skillRuns';
import { skillsView } from '../src/services/setupSkills';
import { lastItem, present } from './support/items';
import type { SetupHome, SetupItem, SetupMachine, SetupRepo, SetupRepoSkill, SkillChange, SyncChange } from '../src/native/types';

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const facts = { files: 2, hasDoc: true, declaredName: null, descriptionChars: 80, whenToUseChars: 0, manualOnly: false, source: null };
const skill = (home: string, name: string, sum: string | null, fields: Partial<SetupItem> = {}): SetupItem => ({
  kind: 'skill', name, path: `${home}/skills/${name}`, sum, size: null, link: null, value: null, note: null, count: null, enabled: null,
  text: false, skill: facts, import: null, ...fields,
});
const linked = (home: string, name: string, sum: string) => skill(home, name, sum, { link: `~/.agents/skills/${name}` });
const home = (agent: SetupHome['agent'], path: string, items: SetupItem[]): SetupHome => ({
  agent, path, items, problems: [], skillsLink: null, skillOverrides: [], ignoredOverrides: [], deniedMcp: [], shares: null,
});
const machine = (name: string, homes: SetupHome[]): SetupMachine => ({
  machine: name, local: false, reachable: true, homes, harnessHomes: [], harnessInstalls: [], installs: [], policy: null, scannedAt: 1_000, error: null, scanning: false,
});
const repoSkill = (name: string, sum: string): SetupRepoSkill => ({
  name, path: `~/.agents/skills/${name}`, sum, ck: 'c9-40', files: 2, size: 1_024, problem: null, source: null,
});
const repo = (skills: SetupRepoSkill[], fields: Partial<SetupRepo> = {}): SetupRepo => ({
  path: '/Users/casey/src/agent-setup', branch: 'main', head: { sha: sha('ab'), subject: 'Start', atMs: 1_000 },
  upstream: null, uncommitted: [], files: [], skills, ignored: [], skillMachines: {}, removedSkills: [], removedFiles: [], fileMachines: {},
  skillProjects: {}, mcpProjects: {}, instructions: [], plugins: [], codexPlugins: [], ...fields,
});

const STORE = '~/.agents';
const CLAUDE = '~/.claude';
const CODEX = '~/.codex';

// casey-mbp has notes only in Claude Code's own folder; ci-01 has a different copy only in Codex's.
const notesFleet = () => [
  machine('casey-mbp', [home('shared', STORE, []), home('claude', CLAUDE, [skill(CLAUDE, 'notes', sha('3'))]), home('codex', CODEX, [])]),
  machine('ci-01', [home('shared', STORE, []), home('claude', CLAUDE, []), home('codex', CODEX, [skill(CODEX, 'notes', sha('4'))])]),
];

// pdf is in the repo and every store; casey-mbp's Claude Code links to it, ci-01's keeps an older copy.
const pdfFleet = () => [
  machine('casey-mbp', [home('shared', STORE, [skill(STORE, 'pdf', sha('1'))]), home('claude', CLAUDE, [linked(CLAUDE, 'pdf', sha('1'))]), home('codex', CODEX, [])]),
  machine('ci-01', [home('shared', STORE, [skill(STORE, 'pdf', sha('1'))]), home('claude', CLAUDE, [skill(CLAUDE, 'pdf', sha('2'))]), home('codex', CODEX, [])]),
];

/** Each machine's home changes as `[home, action]`, store copies in and out, and why anything was left. */
const outline = (plan: SkillPlan) => plan.machines.map((entry) => ({
  machine: entry.machine,
  storeIn: entry.storeIn,
  storeOut: entry.storeOut,
  homes: entry.homes.map((change) => [change.cell.home.path, change.action]),
  kept: entry.kept.map((kept) => [kept.home, kept.reason]),
}));

describe('planning a skill change across machines', () => {
  it('adds a skill the repo hasn’t got from the chosen machine’s copy, into every store and on in every home', () => {
    const plan = planSkills('add', ['notes'], notesFleet(), repo([]), 'casey-mbp');
    expect(plan.takes.map((take) => [take.machine, take.home, take.agent])).toEqual([['casey-mbp', CLAUDE, 'claude']]);
    // Both copies are offered, the chosen machine's first.
    expect(present(plan.copies.notes, 'notes copies').map((copy) => copy.machine)).toEqual(['casey-mbp', 'ci-01']);
    expect(outline(plan)).toEqual([
      // Its own copy gives way to a link to the store's, once the store has it.
      { machine: 'casey-mbp', storeIn: ['notes'], storeOut: [], homes: [[CLAUDE, 'useStore']], kept: [] },
      // Codex loads the store's copy itself, so its own would load twice.
      { machine: 'ci-01', storeIn: ['notes'], storeOut: [], homes: [[CLAUDE, 'link'], [CODEX, 'remove']], kept: [] },
    ]);
    expect(planSize(plan)).toEqual({ commits: 1, machines: 2, changes: 5 });
    expect(putsOnly(plan)).toBe(false);
  });

  it('takes another machine’s copy when one is picked, and leaves out a skill with no copy to take', () => {
    const machines = notesFleet();
    const theirs = present(skillCopies(machines, 'notes').find((copy) => copy.machine === 'ci-01'), 'ci-01 copy');
    const plan = planSkills('add', ['notes', 'ghost'], machines, repo([]), 'casey-mbp', { notes: theirs });
    expect(plan.takes.map((take) => [take.machine, take.home])).toEqual([['ci-01', CODEX]]);
    expect([plan.names, plan.uncopied]).toEqual([['notes'], ['ghost']]);
  });

  it('knows which skills some machine has a copy of the repo could take', () => {
    const machines = notesFleet();
    // A link and a folder without a SKILL.md are no copy to take.
    machines.push(machine('cedar-02', [home('shared', STORE, []), home('claude', CLAUDE, [
      skill(CLAUDE, 'browser', sha('5'), { link: '~/src/browser' }),
      skill(CLAUDE, 'draft', sha('6'), { skill: { ...facts, hasDoc: false } }),
    ])]));
    expect([...takeableSkills(machines)]).toEqual(['notes']);
    expect(skillCopies(machines, 'browser')).toEqual([]);
  });

  it('puts a skill the repo has on the machines missing it without a commit', () => {
    const machines = pdfFleet();
    machines.push(machine('cedar-02', [home('shared', STORE, []), home('claude', CLAUDE, [])]));
    const plan = planSkills('add', ['pdf'], machines, repo([repoSkill('pdf', sha('1'))]));
    expect(putsOnly(plan)).toBe(true);
    expect(outline(plan)).toEqual([
      { machine: 'ci-01', storeIn: [], storeOut: [], homes: [[CLAUDE, 'useStore']], kept: [] },
      { machine: 'cedar-02', storeIn: ['pdf'], storeOut: [], homes: [[CLAUDE, 'link']], kept: [] },
    ]);
    expect(planSize(plan).commits).toBe(0);
  });

  it('puts back a skill the repo took off every machine rather than taking a machine’s copy', () => {
    const machines = notesFleet();
    const plan = planSkills('add', ['notes'], machines, repo([], { removedSkills: ['notes'] }));
    expect([plan.putBack, plan.takes]).toEqual([['notes'], []]);
  });

  it('leaves alone a machine the repo keeps a skill off, or lets keep its own', () => {
    const plan = planSkills('add', ['pdf'], [...pdfFleet(), machine('cedar-02', [home('shared', STORE, []), home('claude', CLAUDE, [])])], repo([repoSkill('pdf', sha('1'))], {
      skillMachines: { pdf: { ci01: 'own', cedar02: 'off' } },
    }));
    expect(outline(plan)).toEqual([
      { machine: 'ci-01', storeIn: [], storeOut: [], homes: [], kept: [[null, 'ownHere']] },
      { machine: 'cedar-02', storeIn: [], storeOut: [], homes: [], kept: [[null, 'offHere']] },
    ]);
  });

  it('removes a skill from every home and store, keeping it where the repo lets a machine keep its own', () => {
    const plan = planSkills('remove', ['pdf'], pdfFleet(), repo([repoSkill('pdf', sha('1'))]));
    expect(outline(plan)).toEqual([
      { machine: 'casey-mbp', storeIn: [], storeOut: ['pdf'], homes: [[CLAUDE, 'remove']], kept: [] },
      { machine: 'ci-01', storeIn: [], storeOut: ['pdf'], homes: [[CLAUDE, 'remove']], kept: [] },
    ]);
    const keeping = planSkills('remove', ['pdf'], pdfFleet(), repo([repoSkill('pdf', sha('1'))], { skillMachines: { pdf: { ci01: 'own' } } }));
    expect(outline(keeping).map((entry) => [entry.machine, entry.kept])).toEqual([['casey-mbp', []], ['ci-01', [[null, 'ownHere']]]]);
    expect(planSize(plan).commits).toBe(1);
  });

  it('marks only the skills the repo hasn’t taken off already, still clearing what machines have', () => {
    const plan = planSkills('remove', ['pdf', 'notes'], pdfFleet(), repo([], { removedSkills: ['pdf'] }));
    expect(plan.marks).toEqual(['notes']);
    expect(outline(plan).map((entry) => [entry.machine, entry.homes])).toEqual([['casey-mbp', [[CLAUDE, 'remove']]], ['ci-01', [[CLAUDE, 'remove']]]]);
    expect([planSize(plan).commits, touchedSkills(plan)]).toEqual([1, ['pdf', 'notes']]);
  });

  it('turns a skill off only where a home links to the store’s copy, keeping a copy of its own', () => {
    const plan = planSkills('off', ['pdf'], pdfFleet(), null);
    expect(outline(plan)).toEqual([
      { machine: 'casey-mbp', storeIn: [], storeOut: [], homes: [[CLAUDE, 'remove']], kept: [] },
      { machine: 'ci-01', storeIn: [], storeOut: [], homes: [], kept: [[CLAUDE, 'ownCopy']] },
    ]);
    // Nothing to commit, so turning it off counts only the homes.
    expect([planSize(plan), touchedSkills(plan)]).toEqual([{ commits: 0, machines: 1, changes: 1 }, ['pdf']]);
  });

  it('turns a skill on only where the machine’s store has it', () => {
    const machines = [...pdfFleet(), machine('cedar-02', [home('shared', STORE, []), home('claude', CLAUDE, [skill(CLAUDE, 'pdf', sha('5'))])])];
    machines[0] = machine('casey-mbp', [home('shared', STORE, [skill(STORE, 'pdf', sha('1'))]), home('claude', CLAUDE, [])]);
    expect(outline(planSkills('on', ['pdf'], machines, null))).toEqual([
      { machine: 'casey-mbp', storeIn: [], storeOut: [], homes: [[CLAUDE, 'link']], kept: [] },
      { machine: 'cedar-02', storeIn: [], storeOut: [], homes: [], kept: [[STORE.concat('/skills'), 'notInStore']] },
    ]);
  });
});

describe('one machine’s ticked skills', () => {
  it('offers what each kind of bulk change would do in its homes', () => {
    const view = skillsView(machine('casey-mbp', [
      home('shared', STORE, [skill(STORE, 'pdf', sha('1')), skill(STORE, 'notes', sha('3'))]),
      home('claude', CLAUDE, [skill(CLAUDE, 'pdf', sha('1'))]),
      home('codex', CODEX, [skill(CODEX, 'notes', sha('3'))]),
    ]));
    const names = new Set(['pdf', 'notes']);
    const summary = (kind: Parameters<typeof bulkHomeChanges>[2]) => bulkHomeChanges(view, names, kind).map((change) => [change.row.name, change.cell.home.path, change.action]);
    expect(summary('link')).toEqual([['notes', CLAUDE, 'link']]);
    expect(summary('useStore')).toEqual([['pdf', CLAUDE, 'useStore']]);
    expect(summary('codexTwice')).toEqual([['notes', CODEX, 'remove']]);
    expect(summary('turnOff')).toEqual([]);
  });

  it('ticks a range from the last row ticked, the way the clicked one went', () => {
    const order = ['a', 'b', 'c', 'd'];
    const one = tickRows(order, new Set(), null, 'b', true, false);
    expect([...tickRows(order, one, 'b', 'd', true, true)]).toEqual(['b', 'c', 'd']);
    expect([...tickRows(order, new Set(order), 'a', 'c', false, true)]).toEqual(['d']);
    // With nothing ticked before, a range is just the row.
    expect([...tickRows(order, new Set(), null, 'c', true, true)]).toEqual(['c']);
  });
});

describe('running a skill change and undoing it', () => {
  let originalWindow: PropertyDescriptor | undefined;
  let fleet: SetupMachine[];
  let current: SetupRepo;
  let calls: ReturnType<typeof mockCommands>;
  let backups: number;
  // What ci-01's Codex copy of notes really is, which a change is checked against.
  let codexNotes: string;

  const outcome = (machineName: string) => ({ backup: `${machineName}-${(backups += 1)}`, done: [], failed: [] });
  const find = (name: string) => present(fleet.find((entry) => entry.machine === name), name);
  const homeOf = (entry: SetupMachine, path: string) => present(entry.homes.find((candidate) => candidate.path === path), path);

  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
    fleet = notesFleet();
    current = repo([]);
    backups = 0;
    codexNotes = sha('4');
    calls = mockCommands({
      get_setup_inventory: () => ({ machines: fleet }),
      take_setup_skills: ({ paths }) => {
        current = { ...current, skills: [...current.skills, ...paths.map((path) => repoSkill(path.slice(path.lastIndexOf('/') + 1), sha('3')))] };
        return current;
      },
      drop_setup_skills: ({ skills }) => {
        current = { ...current, skills: current.skills.filter((entry) => !skills.includes(entry.name)) };
        return current;
      },
      // The store gets the repo's copy, which the next read finds.
      apply_setup_sync: ({ machine: name, changes }) => {
        const store = homeOf(find(name), STORE);
        store.items = [...store.items, ...changes.map((change: SyncChange) => skill(STORE, change.path.slice(change.path.lastIndexOf('/') + 1), sha('3')))];
        return outcome(name);
      },
      apply_skill_changes: ({ machine: name, changes }) => {
        if (name === 'ci-01' && changes.some((change: SkillChange) => change.home === CODEX && change.homeBefore !== `D${codexNotes}`)) {
          return { backup: null, done: [], failed: [{ path: '~/.codex/skills/notes', reason: 'changed' }] };
        }
        return outcome(name);
      },
      set_setup_skill_removed: ({ skill: name, removed }) => {
        const others = current.removedSkills.filter((entry) => entry !== name);
        current = { ...current, removedSkills: removed ? [...others, name] : others };
        return current;
      },
      undo_setup_sync: ({ machine: name }) => ({ backup: null, done: [name], failed: [] }),
      track_event: () => undefined,
    });
  });

  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('commits the skill, fills each store, then changes the homes, and undoes it the other way round', async () => {
    const plan = planSkills('add', ['notes'], fleet, current, 'casey-mbp');
    const seen: SkillRunProgress[] = [];
    const done = await runSkillPlan(plan, current, (progress) => seen.push(progress));
    expect(runSucceeded(done)).toBe(true);
    expect(seen[0]?.repo).toBe('running');
    expect(lastItem(seen).machines).toEqual({ 'casey-mbp': { phase: 'done', problem: null }, 'ci-01': { phase: 'done', problem: null } });
    expect(done.repoSteps).toEqual([{ name: 'notes', step: 'taken' }]);
    // A store write, then a home change, on each machine.
    expect(done.backups.map((entry) => entry.machine).sort()).toEqual(['casey-mbp', 'casey-mbp', 'ci-01', 'ci-01']);
    const order = calls.map((call) => call.command).filter((command) => command !== 'get_setup_inventory' && command !== 'track_event');
    expect(order[0]).toBe('take_setup_skills');
    expect(order.indexOf('apply_skill_changes')).toBeGreaterThan(order.indexOf('apply_setup_sync'));

    calls.length = 0;
    expect(undoSucceeded(await undoSkillRun(done))).toBe(true);
    const undone = calls.filter((call) => call.command === 'undo_setup_sync' && call.args.machine === 'casey-mbp').map((call) => call.args.backup);
    // The home change first, then the store write.
    expect(undone).toEqual(done.backups.filter((entry) => entry.machine === 'casey-mbp').map((entry) => entry.backup).reverse());
    expect(lastItem(calls)).toEqual({ command: 'drop_setup_skills', args: { repo: current.path, skills: ['notes'] } });
  });

  it('reports a machine whose home changed since the scan, keeping what the others did for Undo', async () => {
    const plan = planSkills('add', ['notes'], fleet, current, 'casey-mbp');
    // ci-01's Codex copy changed after it was last read.
    codexNotes = sha('7');
    const done = await runSkillPlan(plan, current, () => undefined);
    expect(runSucceeded(done)).toBe(false);
    expect(done.problems).toEqual({ 'ci-01': { kind: 'changed', paths: ['~/.codex/skills/notes'] } });
    expect(done.backups.some((entry) => entry.machine === 'casey-mbp')).toBe(true);
  });

  it('takes a skill off every machine, and on Undo leaves one the repo had taken off before', async () => {
    current = repo([], { removedSkills: ['ghost'] });
    const plan = planSkills('remove', ['notes', 'ghost'], fleet, current);
    const done = await runSkillPlan(plan, current, () => undefined);
    expect(runSucceeded(done)).toBe(true);
    expect([done.repoSteps, current.removedSkills]).toEqual([[{ name: 'notes', step: 'removed' }], ['ghost', 'notes']]);
    // Each machine's own copy goes from its home.
    const homes = calls.filter((call) => call.command === 'apply_skill_changes').map((call) => [call.args.machine, (call.args.changes as SkillChange[]).map((change) => [change.home, change.action])]);
    expect(homes.sort()).toEqual([['casey-mbp', [[CLAUDE, 'remove']]], ['ci-01', [[CODEX, 'remove']]]]);
    expect(undoSucceeded(await undoSkillRun(done))).toBe(true);
    expect(current.removedSkills).toEqual(['ghost']);
  });

  it('stops before any machine when the repo can’t take the skill', async () => {
    mockCommands({ take_setup_skills: () => { throw 'uncommitted changes'; }, track_event: () => undefined });
    const plan = planSkills('add', ['notes'], fleet, current, 'casey-mbp');
    const done = await runSkillPlan(plan, current, () => undefined);
    expect([done.repoError, done.backups, done.repoSteps]).toEqual(['uncommitted changes', [], []]);
  });
});

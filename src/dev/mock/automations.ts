import type { AutomationCommands } from '../../native/automations';
import type {
  Automation,
  AutomationAbilities,
  AutomationDraft,
  AutomationList,
  AutomationRun,
  AutomationRunStatus,
  AutomationSummary,
  UdianOnMachine,
} from '../../native/types';
import type { CommandAnswers } from './answers';
import { freshInstall, later, mockLog, now, params } from './scenario';

/**
 * `?automations=empty`: none anywhere, so the page offers New automation. `?automations=failing`: the newest runs of
 * two failed and a machine couldn't be scanned. `?orca=none`: Orca isn't on any machine, so none of its show.
 * `?draft=fail`: the drafting model can't be reached (the core has no key); `?draft=slow` takes four seconds.
 * The background runner: casey-mbp and cedar-02 have it and ci-01 doesn't. `?runner=old`: cedar-02's is older than
 * the one Arbor carries. `?runner=failing`: writing cedar-02's schedules failed. `?runner=none`: this build carries none.
 */
const scenario = params.get('automations');
const failing = scenario === 'failing';
const withOrca = params.get('orca') !== 'none';
const runner = params.get('runner');
const BUNDLED_RUNNER = runner === 'none' ? null : '1.0.0';
const runnerOn = new Map<string, UdianOnMachine>([
  ['casey-mbp', { target: 'darwin-arm64', version: '1.0.0', live: true }],
  ['cedar-02', { target: 'linux-x64', version: runner === 'old' ? '0.9.2' : '1.0.0', live: true }],
  ['ci-01', { target: 'linux-arm64', version: null, live: false }],
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ARBOR_ABILITIES: AutomationAbilities = { edit: true, pause: true, runNow: true, delete: true, copy: false };
const CODEX_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: false, delete: false, copy: true };
const CLAUDE_ABILITIES: AutomationAbilities = { edit: false, pause: false, runNow: false, delete: false, copy: true };
const ORCA_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: true, delete: false, copy: true };

type Seed = Omit<Automation, 'summary'> & { summary: AutomationSummary };

const machine = (name: string) => ({ kind: 'machine' as const, name });

// A summary's model is the one the automation is set to unless it says which one its last run used.
const seed = (summary: Omit<AutomationSummary, 'target' | 'runsOn' | 'model'> & { target?: AutomationSummary['target']; runsOn?: AutomationSummary['runsOn']; model?: string | null }, detail: Partial<Omit<Automation, 'summary'>> & { prompt: string }): Seed => ({
  summary: { target: summary.machine ? machine(summary.machine) : { kind: 'best' }, runsOn: 'app', model: detail.model ?? null, ...summary },
  rrule: null,
  timezone: null,
  projectPath: null,
  workspace: 'checkout',
  session: 'fresh',
  access: 'edits',
  model: null,
  effort: null,
  precheck: null,
  precheckTimeoutSecs: 60,
  graceMinutes: 60,
  sourcePath: null,
  createdAtMs: now - 20 * DAY,
  updatedAtMs: now - 3 * DAY,
  ...detail,
});

const SEEDS: Seed[] = [
  seed({
    id: 'arbor:sentry-watch', source: 'arbor', name: 'Sentry watch', enabled: true, machine: 'cedar-02', project: 'billing', agent: 'claude', runsOn: 'machine',
    schedule: { kind: 'everyHours', hours: 1, minute: 15 }, nextRunAtMs: now + 23 * MINUTE,
    lastRun: { status: failing ? 'failed' : 'done', atMs: now - 37 * MINUTE }, hasPrecheck: true, abilities: ARBOR_ABILITIES,
  }, {
    prompt: [
      '## Sentry triage',
      '',
      'Look at the unresolved Sentry issues the precheck listed.',
      '',
      '1. Group them by cause.',
      '2. Open one fix per cause on its own branch, with a test that fails without it.',
      '3. Leave anything you can\'t reproduce alone.',
      '',
      '### When you\'re done',
      '',
      '- Post a short summary of what you changed and what you left.',
      '- Link each branch and the issues it closes.',
      '- Don\'t resolve issues in Sentry; the fix landing does that.',
    ].join('\n'),
    rrule: 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=15', projectPath: '/home/casey/src/billing', workspace: 'newWorktree',
    precheck: './scripts/sentry-unresolved.sh --since 1h', precheckTimeoutSecs: 60, graceMinutes: 30, model: 'claude-sonnet-5', effort: 'high',
  }),
  seed({
    id: 'arbor:daily-changelog', source: 'arbor', name: 'Daily changelog', enabled: true, machine: 'casey-mbp', project: 'arbor', agent: 'codex', runsOn: 'machine', model: 'gpt-6-sol',
    schedule: { kind: 'daily', hour: 17, minute: 0 }, nextRunAtMs: now + 7 * HOUR,
    lastRun: { status: 'done', atMs: now - 17 * HOUR }, hasPrecheck: true, abilities: ARBOR_ABILITIES,
  }, {
    prompt: 'Write today\'s changelog from the commits merged to main since the last entry. Keep it to what a user would notice.',
    rrule: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0', projectPath: '/Users/casey/src/arbor',
    precheck: 'git fetch -q && test -n "$(git log --since=1.day --oneline origin/main)"', precheckTimeoutSecs: 30, graceMinutes: 720,
    session: 'reuse',
  }),
  seed({
    // Runs on whichever member of the Builds pool has room when it's due.
    id: 'arbor:regression-scan', source: 'arbor', name: 'Regression scan', enabled: true, machine: null, target: { kind: 'pool', id: 'mock-builds' }, project: 'proxy', agent: 'codex', model: 'gpt-6-luna',
    schedule: { kind: 'weekdays', hour: 6, minute: 0 }, nextRunAtMs: now + 20 * HOUR,
    lastRun: { status: failing ? 'failed' : 'skipped', atMs: now - 4 * HOUR }, hasPrecheck: true, abilities: ARBOR_ABILITIES,
  }, {
    prompt: 'Run the test suite and the benchmarks. If anything got slower or started failing since yesterday, find the commit and open an issue with what you found.',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0', projectPath: '/home/casey/src/proxy',
    precheck: 'git fetch -q && test "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)"', precheckTimeoutSecs: 60,
  }),
  seed({
    id: 'arbor:hygiene-sweep', source: 'arbor', name: 'Hygiene sweep', enabled: false, machine: null, project: 'docs', agent: 'claude', model: 'claude-opus-5-5',
    schedule: { kind: 'weekly', days: [0], hour: 3, minute: 0 }, nextRunAtMs: null,
    lastRun: { status: 'done', atMs: now - 12 * DAY }, hasPrecheck: false, abilities: ARBOR_ABILITIES,
  }, {
    prompt: 'Find broken links, stale screenshots and pages that mention removed settings. Fix what you can and list the rest.',
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=3;BYMINUTE=0', projectPath: '~/src/docs',
  }),
  seed({
    id: 'codexApp:casey-mbp:inbox-triage', source: 'codexApp', name: 'Inbox triage', enabled: true, machine: 'casey-mbp', project: null, agent: 'codex', model: 'gpt-6-sol',
    schedule: { kind: 'everyMinutes', minutes: 30 }, nextRunAtMs: now + 11 * MINUTE,
    lastRun: null, hasPrecheck: false, abilities: CODEX_ABILITIES,
  }, {
    prompt: 'Go through new messages since the last run, label them and draft replies to the ones that need one.',
    rrule: 'RRULE:FREQ=MINUTELY;INTERVAL=30', sourcePath: '~/.codex/automations/inbox-triage/automation.toml',
  }),
  seed({
    id: 'codexApp:casey-mbp:history-compactor', source: 'codexApp', name: 'History compactor', enabled: false, machine: 'casey-mbp', project: null, agent: 'codex',
    schedule: { kind: 'daily', hour: 1, minute: 0 }, nextRunAtMs: null,
    lastRun: null, hasPrecheck: false, abilities: CODEX_ABILITIES,
  }, {
    prompt: 'Summarize and compact old notes into the archive file.',
    rrule: 'RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=1;BYMINUTE=0;BYSECOND=0', sourcePath: '~/.codex/automations/history-compactor/automation.toml',
  }),
  seed({
    id: 'claudeDesktop:casey-mbp:meeting-notes', source: 'claudeDesktop', name: 'Meeting notes to wiki', enabled: true, machine: 'casey-mbp', project: null, agent: 'claude',
    schedule: { kind: 'elsewhere' }, nextRunAtMs: null,
    lastRun: null, hasPrecheck: false, abilities: CLAUDE_ABILITIES,
  }, {
    prompt: 'Take the newest meeting notes and add them to the team wiki, linking terms that already have pages.',
    sourcePath: '~/.claude/scheduled-tasks/meeting-notes/SKILL.md',
  }),
  ...(withOrca ? [
    seed({
      id: 'orca:7c1f', source: 'orca', name: 'Translation fill', enabled: false, machine: 'cedar-02', project: 'billing', agent: 'claude', model: 'claude-fable-5-1',
      schedule: { kind: 'weekly', days: [1], hour: 10, minute: 0 }, nextRunAtMs: null,
      lastRun: { status: 'skipped', atMs: now - 9 * DAY }, hasPrecheck: true, abilities: ORCA_ABILITIES,
    }, {
      prompt: 'Fill in missing translations for strings added this week.',
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0', precheck: 'node scripts/missing-strings.mjs --exit-code', workspace: 'newWorktree',
    }),
    seed({
      id: 'orca:2a9b', source: 'orca', name: 'Weekday repo audit', enabled: true, machine: 'cedar-02', project: 'billing', agent: 'codex', model: 'gpt-6-sol',
      schedule: { kind: 'weekdays', hour: 9, minute: 0 }, nextRunAtMs: now + 3 * DAY,
      lastRun: { status: 'done', atMs: now - 34 * MINUTE }, hasPrecheck: false, abilities: ORCA_ABILITIES,
    }, {
      prompt: 'Audit open pull requests for missing tests and stale branches.',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', session: 'reuse',
    }),
  ] : []),
];

let automations: Seed[] = freshInstall || scenario === 'empty' ? [] : SEEDS.map((item) => structuredClone(item));
let running = params.get('automations') !== 'off';

const RUN_STATUSES: AutomationRunStatus[] = ['done', 'skipped', 'done', 'skipped', 'skipped', 'done', 'failed', 'done', 'missed', 'done', 'skipped', 'unreachable'];

/** Each automation's recent runs, newest first, from its schedule's spacing. */
function seedRuns(item: Seed): AutomationRun[] {
  const last = item.summary.lastRun;
  if (!last) return [];
  const step = item.summary.schedule.kind === 'everyHours' ? HOUR : item.summary.schedule.kind === 'everyMinutes' ? 30 * MINUTE : DAY;
  return RUN_STATUSES.map((fallback, index) => {
    const status = index === 0 ? last.status : fallback;
    const scheduledAtMs = last.atMs - index * step;
    const ran = status === 'done' || status === 'failed';
    const checked = ran || status === 'skipped';
    return {
      id: `${item.summary.id}:run:${index}`,
      automationId: item.summary.id,
      machine: item.summary.machine ?? 'cedar-02',
      status,
      scheduledAtMs,
      startedAtMs: status === 'missed' || status === 'unreachable' ? null : scheduledAtMs + 2_000,
      finishedAtMs: status === 'missed' || status === 'unreachable' ? null : scheduledAtMs + (ran ? (6 + index) * MINUTE : 4_000),
      manual: index === 3,
      precheckExit: checked && item.summary.hasPrecheck ? (status === 'skipped' ? 1 : 0) : null,
      precheckOutput: checked && item.summary.hasPrecheck
        ? status === 'skipped' ? 'nothing new since the last run' : '3 unresolved issues: BILLING-412, BILLING-415, BILLING-420'
        : null,
      exitCode: ran ? (status === 'failed' ? 1 : 0) : null,
      sessionId: ran ? `5f2c${index}e1a-7d4b-4c1e-9a0f-0c6b2d8e${String(index).padStart(4, '0')}` : null,
      error: status === 'failed' ? 'The agent stopped with exit code 1.' : status === 'unreachable' ? 'cedar-02 didn\'t answer over SSH.' : null,
    };
  });
}

let draftModel = 'gpt-6-luna';
let draftEffort = 'low';

const runs = new Map<string, AutomationRun[]>(automations.map((item) => [item.summary.id, seedRuns(item)]));

const list = (): AutomationList => ({
  automations: automations.map((item) => item.summary),
  scans: [
    { machine: 'casey-mbp', scannedAtMs: now - 6 * MINUTE, scanning: false, error: null, orca: false, udian: runnerOn.get('casey-mbp') ?? null, placingError: null },
    {
      machine: 'cedar-02', scannedAtMs: now - 6 * MINUTE, scanning: false, error: null, orca: withOrca, udian: runnerOn.get('cedar-02') ?? null,
      placingError: runner === 'failing' ? 'cedar-02 didn\'t answer over SSH.' : null,
    },
    {
      machine: 'ci-01', scannedAtMs: failing ? now - 3 * HOUR : now - 6 * MINUTE, scanning: false, error: failing ? 'ci-01 didn\'t answer over SSH.' : null, orca: false,
      udian: failing ? null : runnerOn.get('ci-01') ?? null, placingError: null,
    },
  ],
  running,
  draftModel,
  draftEffort,
  udianBundled: BUNDLED_RUNNER,
  agents: ['claude', 'codex', 'pi', 'primeAgent', 'droid'],
});

const find = (id: string) => {
  const item = automations.find((entry) => entry.summary.id === id);
  if (!item) throw `No automation ${id}`;
  return item;
};

const projectName = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** A description, made into a draft the way the model would, from the words it has. */
function mockDraft(description: string): AutomationDraft {
  const text = description.toLowerCase();
  const hourly = text.includes('hour');
  const daily = text.includes('day') || text.includes('morning');
  const sentry = text.includes('sentry');
  return {
    name: sentry ? 'Sentry watch' : description.split(/[.,]/)[0]?.slice(0, 40).trim() || 'New automation',
    prompt: sentry
      ? 'The precheck listed the unresolved Sentry issues seen in the last hour. Group them by cause. For each cause, start a fix on its own branch with a test that reproduces it, and open a pull request. Skip issues that already have an open pull request. End with a short summary: what you fixed, what you left and why.'
      : `${description.trim()}\n\nWork only on what the precheck found. End with a short summary of what you did.`,
    rrule: hourly ? 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=0' : daily ? 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' : 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',
    precheck: sentry ? 'sentry-cli issues list --query "is:unresolved lastSeen:-1h" | grep -q .' : 'test -n "$(git log --since=1.day --oneline)"',
    precheckTimeoutSecs: 60,
    agent: 'claude',
    session: 'fresh',
    graceMinutes: hourly ? 30 : 720,
    note: sentry ? 'Needs sentry-cli signed in on the machine.' : null,
  };
}

export const automationsAnswers: CommandAnswers<AutomationCommands> = {
  list_automations: () => list(),
  scan_automations: ({ machine: name }) => later(1_200, () => {
    mockLog('scan_automations', { machine: name ?? null });
    return list();
  }),
  get_automation: ({ id }) => structuredClone(find(id)),
  list_automation_runs: ({ id, limit }) => {
    const all = id ? runs.get(id) ?? [] : [...runs.values()].flat().sort((left, right) => right.scheduledAtMs - left.scheduledAtMs);
    return all.slice(0, limit ?? 100);
  },
  save_automation: ({ input }) => {
    mockLog('save_automation', input);
    const id = input.id ?? `arbor:${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${automations.length}`;
    const existing = automations.find((entry) => entry.summary.id === id);
    const machineName = input.target.kind === 'machine' ? input.target.name : null;
    const item: Seed = {
      summary: {
        id, source: 'arbor', name: input.name, enabled: input.enabled, machine: machineName, target: input.target,
        project: input.projectPath ? projectName(input.projectPath) : null, agent: input.agent, model: input.model ?? existing?.summary.model ?? null,
        schedule: existing?.summary.schedule ?? { kind: 'custom' }, nextRunAtMs: input.enabled ? now + HOUR : null,
        lastRun: existing?.summary.lastRun ?? null, hasPrecheck: Boolean(input.precheck), abilities: ARBOR_ABILITIES, runsOn: input.runsOn,
      },
      prompt: input.prompt, rrule: input.rrule, timezone: input.timezone ?? null, projectPath: input.projectPath,
      workspace: input.workspace, session: input.session, access: input.access, model: input.model ?? null, effort: input.effort ?? null,
      precheck: input.precheck ?? null, precheckTimeoutSecs: input.precheckTimeoutSecs, graceMinutes: input.graceMinutes,
      sourcePath: null, createdAtMs: existing?.createdAtMs ?? Date.now(), updatedAtMs: Date.now(),
    };
    automations = existing ? automations.map((entry) => (entry.summary.id === id ? item : entry)) : [...automations, item];
    if (!runs.has(id)) runs.set(id, []);
    return structuredClone(item);
  },
  delete_automation: ({ id }) => {
    mockLog('delete_automation', { id });
    automations = automations.filter((entry) => entry.summary.id !== id);
    runs.delete(id);
    return list();
  },
  set_automation_enabled: ({ id, enabled }) => {
    mockLog('set_automation_enabled', { id, enabled });
    const item = find(id);
    item.summary.enabled = enabled;
    item.summary.nextRunAtMs = enabled ? now + HOUR : null;
    return list();
  },
  run_automation_now: ({ id }) => {
    mockLog('run_automation_now', { id });
    const item = find(id);
    const run: AutomationRun = {
      id: `${id}:run:now-${Date.now()}`, automationId: id, machine: item.summary.machine ?? 'cedar-02', status: 'running',
      scheduledAtMs: Date.now(), startedAtMs: Date.now(), finishedAtMs: null, manual: true,
      precheckExit: item.summary.hasPrecheck ? 0 : null, precheckOutput: item.summary.hasPrecheck ? '2 unresolved issues' : null,
      exitCode: null, sessionId: null, error: null,
    };
    runs.set(id, [run, ...(runs.get(id) ?? [])]);
    item.summary.lastRun = { status: 'running', atMs: run.scheduledAtMs };
    return run;
  },
  cancel_automation_run: ({ runId }) => {
    mockLog('cancel_automation_run', { runId });
    for (const [id, entries] of runs) {
      const run = entries.find((entry) => entry.id === runId);
      if (!run) continue;
      run.status = 'canceled';
      run.finishedAtMs = Date.now();
      const item = automations.find((entry) => entry.summary.id === id);
      if (item?.summary.lastRun) item.summary.lastRun.status = 'canceled';
      return run;
    }
    throw `No run ${runId}`;
  },
  copy_automation_into_arbor: ({ id, pauseOriginal }) => {
    mockLog('copy_automation_into_arbor', { id, pauseOriginal });
    const original = find(id);
    if (pauseOriginal && original.summary.abilities.pause) original.summary.enabled = false;
    const copyId = `arbor:copy-${id.split(':').pop()}`;
    const copy: Seed = {
      ...structuredClone(original),
      summary: { ...structuredClone(original.summary), id: copyId, source: 'arbor', enabled: false, abilities: ARBOR_ABILITIES, lastRun: null, nextRunAtMs: null },
      sourcePath: null,
      rrule: original.rrule ?? 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    };
    automations = [...automations, copy];
    runs.set(copyId, []);
    return structuredClone(copy);
  },
  draft_automation: ({ input }) => {
    mockLog('draft_automation', input);
    const draft = params.get('draft');
    if (draft === 'fail') {
      return later(900, () => {
        throw 'Arbor needs a client key on the proxy to draft with. Add one in Settings › Proxy, or fill it in yourself.';
      });
    }
    return later(draft === 'slow' ? 4_000 : 1_400, () => mockDraft(input.description));
  },
  set_automations_running: ({ running: next }) => {
    mockLog('set_automations_running', { running: next });
    running = next;
    return list();
  },
  set_automation_draft_model: ({ model, effort }) => {
    mockLog('set_automation_draft_model', { model, effort });
    draftModel = model;
    draftEffort = effort;
    return list();
  },
  install_background_runner: ({ machine: name }) => later(2_500, () => {
    mockLog('install_background_runner', { machine: name });
    const found = runnerOn.get(name);
    if (!found?.target || !BUNDLED_RUNNER) throw 'Arbor has no background runner for this machine\'s system';
    runnerOn.set(name, { ...found, version: BUNDLED_RUNNER, live: true });
    return list();
  }),
};

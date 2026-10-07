import type { AutomationCommands } from '../../native/automations';
import type {
  Automation,
  AutomationAbilities,
  AutomationDraft,
  AutomationList,
  AutomationRun,
  AutomationRunStatus,
  AutomationSource,
  AutomationSummary,
  ScheduleSummary,
  UdianOnMachine,
} from '../../native/types';
import { choiceSummary, scheduleChoice } from '../../services/automations';
import type { CommandAnswers } from './answers';
import { freshInstall, later, mockLog, now, params } from './scenario';
import { mockHarnessesFound } from './setup';

/**
 * `?automations=empty`: none anywhere, so the page offers New automation. `?automations=failing`: the newest runs of
 * two failed and a machine couldn't be scanned. `?orca=none`: Orca isn't on any machine, so none of its show, and
 * `?superset=none` the same for Superset, whose cloud one (no machine, no prompt to copy) runs in its own workspace.
 * `?draft=fail`: the drafting model can't be reached (the core has no key); `?draft=slow` takes four seconds.
 * The background runner: cam-mbp and cedar-02 have it and ci-01 doesn't. `?runner=old`: cedar-02's is older than
 * the one Arbor carries, and `?runner=legacy` from before it kept only 30 days of runs. `?runner=failing`: writing
 * cedar-02's schedules failed. `?runner=none`: this build carries none. `?automations=nokey`: the proxy has no
 * Automations key yet, so Settings offers to add one.
 * Someone's own ultradian schedules: two on cedar-02, and index-sessions on cam-mbp and cedar-02, which the list folds. `?udian=none` hides them; `?udian=away` makes reading their
 * runs from cedar-02 fail. `?terminal=fail`: opening a run in Terminal fails.
 */
const scenario = params.get('automations');
const failing = scenario === 'failing';
const withOrca = params.get('orca') !== 'none';
const withSuperset = params.get('superset') !== 'none';
const udianScenario = params.get('udian');
const withOwnUdian = udianScenario !== 'none';
const runner = params.get('runner');
const BUNDLED_RUNNER = runner === 'none' ? null : '1.0.0';
const BUNDLED_SKILL = runner === 'none' ? null : 'c1234567-6012';
// cam-mbp's runner went on before Arbor carried its skill, so Settings offers to add it.
const runnerOn = new Map<string, UdianOnMachine>([
  ['cam-mbp', { target: 'darwin-arm64', version: '1.0.0', live: true, skill: null }],
  ['cedar-02', { target: 'linux-x64', version: runner === 'old' ? '0.9.2' : runner === 'legacy' ? '0.1.0' : '1.0.0', live: true, skill: BUNDLED_SKILL }],
  ['ci-01', { target: 'linux-arm64', version: null, live: false, skill: null }],
]);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const ARBOR_ABILITIES: AutomationAbilities = { edit: true, pause: true, runNow: true, delete: true, copy: false };
const CODEX_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: false, delete: false, copy: true };
const CLAUDE_ABILITIES: AutomationAbilities = { edit: false, pause: false, runNow: false, delete: false, copy: true };
const ORCA_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: true, delete: false, copy: true };
const SUPERSET_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: true, delete: false, copy: true };
const ULTRADIAN_ABILITIES: AutomationAbilities = { edit: false, pause: true, runNow: true, delete: false, copy: false };

type Seed = Omit<Automation, 'summary'> & { summary: AutomationSummary };

/**
 * When a schedule next comes round after `from`, in this Mac's time, as Rust works it out from the rule; null for one
 * whose times aren't known here (custom rules, other apps' own).
 */
function nextRun(schedule: ScheduleSummary, from: number): number | null {
  const at = new Date(from);
  switch (schedule.kind) {
    case 'everyMinutes': {
      const step = Math.max(1, schedule.minutes) * MINUTE;
      return Math.floor(from / step) * step + step;
    }
    case 'everyHours': {
      at.setMinutes(schedule.minute, 0, 0);
      while (at.getTime() <= from) at.setHours(at.getHours() + Math.max(1, schedule.hours));
      return at.getTime();
    }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const days = schedule.kind === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : schedule.kind === 'weekdays' ? [1, 2, 3, 4, 5] : schedule.days;
      at.setHours(schedule.hour, schedule.minute, 0, 0);
      for (let step = 0; step < 8; step += 1) {
        if (at.getTime() > from && days.includes(at.getDay())) return at.getTime();
        at.setDate(at.getDate() + 1);
      }
      return null;
    }
    default:
      return null;
  }
}

/** The schedule's last time at or before `at`, or null for one whose times aren't known here. */
function previousRun(schedule: ScheduleSummary, at: number): number | null {
  const time = new Date(at);
  switch (schedule.kind) {
    case 'everyMinutes': {
      const step = Math.max(1, schedule.minutes) * MINUTE;
      return Math.floor(at / step) * step;
    }
    case 'everyHours': {
      time.setMinutes(schedule.minute, 0, 0);
      while (time.getTime() > at) time.setHours(time.getHours() - Math.max(1, schedule.hours));
      return time.getTime();
    }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const days = schedule.kind === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : schedule.kind === 'weekdays' ? [1, 2, 3, 4, 5] : schedule.days;
      time.setHours(schedule.hour, schedule.minute, 0, 0);
      for (let step = 0; step < 8; step += 1) {
        if (time.getTime() <= at && days.includes(time.getDay())) return time.getTime();
        time.setDate(time.getDate() - 1);
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * A seed whose next run follows its schedule, for one that has a next run at all, and whose last run sits on one of
 * the schedule's times, so the times on its runs fit the schedule they're listed under: the latest time gone for one
 * still running on schedule, the time it was paused at or before otherwise.
 */
const scheduled = (item: Seed): Seed => {
  const { schedule, lastRun, nextRunAtMs } = item.summary;
  const lastAt = lastRun ? previousRun(schedule, nextRunAtMs === null ? lastRun.atMs : now) : null;
  return {
    ...item,
    summary: {
      ...item.summary,
      nextRunAtMs: nextRunAtMs === null ? null : nextRun(schedule, now) ?? nextRunAtMs,
      lastRun: lastRun && lastAt !== null ? { ...lastRun, atMs: lastAt } : lastRun,
    },
  };
};

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
    rrule: 'FREQ=HOURLY;INTERVAL=1;BYMINUTE=15', projectPath: '/home/cam/src/billing', workspace: 'newWorktree',
    precheck: './scripts/sentry-unresolved.sh --since 1h', precheckTimeoutSecs: 60, graceMinutes: 30, model: 'claude-sonnet-5', effort: 'high',
  }),
  seed({
    id: 'arbor:daily-changelog', source: 'arbor', name: 'Daily changelog', enabled: true, machine: 'cam-mbp', project: 'arbor', agent: 'codex', runsOn: 'machine', model: 'gpt-6-sol',
    schedule: { kind: 'daily', hour: 17, minute: 0 }, nextRunAtMs: now + 7 * HOUR,
    lastRun: { status: 'done', atMs: now - 17 * HOUR }, hasPrecheck: true, abilities: ARBOR_ABILITIES,
  }, {
    prompt: 'Write today\'s changelog from the commits merged to main since the last entry. Keep it to what a user would notice.',
    rrule: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0', projectPath: '/Users/cam/src/arbor',
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
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=6;BYMINUTE=0', projectPath: '/home/cam/src/proxy',
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
    id: 'codexApp:cam-mbp:inbox-triage', source: 'codexApp', name: 'Inbox triage', enabled: true, machine: 'cam-mbp', project: null, agent: 'codex', model: 'gpt-6-sol',
    schedule: { kind: 'everyMinutes', minutes: 30 }, nextRunAtMs: now + 11 * MINUTE,
    lastRun: null, hasPrecheck: false, abilities: CODEX_ABILITIES,
  }, {
    prompt: 'Go through new messages since the last run, label them and draft replies to the ones that need one.',
    rrule: 'RRULE:FREQ=MINUTELY;INTERVAL=30', sourcePath: '~/.codex/automations/inbox-triage/automation.toml',
  }),
  seed({
    id: 'codexApp:cam-mbp:history-compactor', source: 'codexApp', name: 'History compactor', enabled: false, machine: 'cam-mbp', project: null, agent: 'codex',
    schedule: { kind: 'daily', hour: 1, minute: 0 }, nextRunAtMs: null,
    lastRun: null, hasPrecheck: false, abilities: CODEX_ABILITIES,
  }, {
    prompt: 'Summarize and compact old notes into the archive file.',
    rrule: 'RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=1;BYMINUTE=0;BYSECOND=0', sourcePath: '~/.codex/automations/history-compactor/automation.toml',
  }),
  seed({
    id: 'claudeDesktop:cam-mbp:meeting-notes', source: 'claudeDesktop', name: 'Meeting notes to wiki', enabled: true, machine: 'cam-mbp', project: null, agent: 'claude',
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
  ...(withSuperset ? [
    seed({
      id: 'superset:6f1c0d2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f', source: 'superset', name: 'Nightly issue triage', enabled: true, machine: 'ci-01', project: null, agent: 'claude',
      schedule: { kind: 'daily', hour: 2, minute: 0 }, nextRunAtMs: now + 14 * HOUR,
      lastRun: { status: 'done', atMs: now - 10 * HOUR }, hasPrecheck: false, abilities: SUPERSET_ABILITIES,
    }, {
      prompt: 'Label the issues opened since yesterday and close the duplicates, linking each to the one it repeats.',
      rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0', timezone: 'Australia/Melbourne', session: 'reuse',
    }),
    seed({
      id: 'superset:9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', source: 'superset', name: 'Docs refresh', enabled: false, machine: null, target: machine('cam-mbp'), project: null, agent: 'codex',
      schedule: { kind: 'weekly', days: [5], hour: 16, minute: 0 }, nextRunAtMs: null,
      lastRun: { status: 'unreachable', atMs: now - 6 * DAY }, hasPrecheck: false, abilities: { ...SUPERSET_ABILITIES, copy: false },
    }, {
      prompt: '',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0',
    }),
  ] : []),
  ...(withOwnUdian ? [
    seed({
      id: 'ultradian:cedar-02:pr-review', source: 'ultradian', name: 'pr-review', enabled: true, machine: 'cedar-02', project: 'billing', agent: 'claude', runsOn: 'machine',
      schedule: { kind: 'everyHours', hours: 1, minute: 0 }, nextRunAtMs: now + 41 * MINUTE,
      lastRun: { status: failing ? 'failed' : 'skipped', atMs: now - 19 * MINUTE }, hasPrecheck: true, abilities: ULTRADIAN_ABILITIES,
    }, {
      prompt: "claude -p 'Review the pull requests on stdin and leave comments' --model claude-sonnet-5",
      projectPath: '/home/cam/src/billing', precheck: 'gh pr list --search "review-requested:@me" --json number --jq ".[].number"', precheckTimeoutSecs: 3600, graceMinutes: 10,
      model: 'claude-sonnet-5',
    }),
    // The same schedule on each machine, which the list folds into one row.
    ...(['cam-mbp', 'cedar-02'] as const).map((on, index) => seed({
      id: `ultradian:${on}:index-sessions`, source: 'ultradian', name: 'index-sessions', enabled: true, machine: on, project: null, agent: null, runsOn: 'machine',
      schedule: { kind: 'everyMinutes', minutes: 15 }, nextRunAtMs: now + (4 + index * 3) * MINUTE,
      lastRun: { status: failing && index === 1 ? 'failed' : 'done', atMs: now - (11 - index * 3) * MINUTE }, hasPrecheck: false, abilities: ULTRADIAN_ABILITIES,
    }, {
      prompt: 'session-index scan --json', projectPath: on === 'cam-mbp' ? '/Users/cam' : '/home/cam', graceMinutes: 0,
    })),
    seed({
      id: 'ultradian:cedar-02:nightly-backup', source: 'ultradian', name: 'nightly-backup', enabled: false, machine: 'cedar-02', project: null, agent: null, runsOn: 'machine',
      schedule: { kind: 'daily', hour: 2, minute: 30 }, nextRunAtMs: null,
      lastRun: { status: 'done', atMs: now - 3 * DAY }, hasPrecheck: false, abilities: ULTRADIAN_ABILITIES,
    }, {
      prompt: './scripts/backup.sh --to /Volumes/Backup', projectPath: '/home/cam', graceMinutes: 0,
    }),
  ] : []),
];

let automations: Seed[] = freshInstall || scenario === 'empty' ? [] : SEEDS.map((item) => scheduled(structuredClone(item)));
let running = params.get('automations') !== 'off';

const RUN_STATUSES: AutomationRunStatus[] = ['done', 'skipped', 'done', 'skipped', 'skipped', 'done', 'failed', 'done', 'missed', 'done', 'skipped', 'unreachable'];

// What each precheck printed: a run it let through, and one it skipped (null when the check prints nothing, as a
// `test` does, so the run shows only its exit code).
const PRECHECK_OUTPUT: Record<string, { ran: string | null; skipped: string | null }> = {
  'arbor:sentry-watch': { ran: '3 unresolved issues: BILLING-412, BILLING-415, BILLING-420', skipped: 'no unresolved issues in the last hour' },
  'orca:7c1f': { ran: '14 strings missing: de (9), fr (5)', skipped: null },
};

// Sessions the mock's usage has, by agent, for the runs that started one to open. The app links a run to the session
// its agent reported, and every run goes through the proxy, so Arbor has that session's requests.
const RUN_SESSIONS: Record<string, string[]> = {
  claude: ['6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c', 'd4c3b2a1-7f6e-4d5c-9b8a-e1f2a3b4c5d6', 'b7e24c19-0d3a-4f6e-9b21-c4d5e6f7a8b9'],
  codex: ['0199a0f4-6e21-7c3d-9a8b-1c2d3e4f5a6b', '0199a05d-91c2-7b4a-8e6f-2d3e4f5a6b7c'],
};

/** Each automation's recent runs, newest first, at its schedule's times. */
function seedRuns(item: Seed): AutomationRun[] {
  const last = item.summary.lastRun;
  if (!last) return [];
  const { schedule, hasPrecheck } = item.summary;
  const step = schedule.kind === 'everyHours' ? HOUR : schedule.kind === 'everyMinutes' ? 30 * MINUTE : DAY;
  let scheduledAtMs = last.atMs + 1;
  let sessionIndex = 0;
  return RUN_STATUSES.map((fallback, index) => {
    // Only a precheck can skip a run; one without lets every due run start its agent.
    const status = index === 0 ? last.status : fallback === 'skipped' && !hasPrecheck ? 'done' : fallback;
    scheduledAtMs = previousRun(schedule, scheduledAtMs - 1) ?? scheduledAtMs - 1 - step;
    const ran = status === 'done' || status === 'failed';
    const checked = ran || status === 'skipped';
    const output = PRECHECK_OUTPUT[item.summary.id];
    // ultradian runs whatever command it's given, so its own schedules' runs have no session Arbor could know.
    const sessions = item.summary.agent && item.summary.source !== 'ultradian' ? RUN_SESSIONS[item.summary.agent] ?? [] : [];
    const sessionId = ran ? sessions[sessionIndex++ % Math.max(1, sessions.length)] ?? null : null;
    return {
      id: `${item.summary.id}:run:${index}`,
      automationId: item.summary.id,
      machine: item.summary.machine ?? 'cedar-02',
      status,
      scheduledAtMs,
      startedAtMs: status === 'missed' || status === 'unreachable' ? null : scheduledAtMs + 2_000,
      finishedAtMs: status === 'missed' || status === 'unreachable' ? null : scheduledAtMs + (ran ? (6 + index) * MINUTE : 4_000),
      manual: index === 3,
      precheckExit: checked && hasPrecheck ? (status === 'skipped' ? 1 : 0) : null,
      precheckOutput: checked && hasPrecheck ? (status === 'skipped' ? output?.skipped : output?.ran) ?? null : null,
      exitCode: ran ? (status === 'failed' ? 1 : 0) : null,
      sessionId,
      error: status === 'failed' ? 'The agent stopped with exit code 1.' : status === 'unreachable' ? 'cedar-02 didn\'t answer over SSH.' : null,
    };
  });
}

let draftModel = 'gpt-6-luna';
let draftEffort = 'low';
let proxyKey = scenario !== 'nokey' && !freshInstall;
let proxyAddress = '';

const runs = new Map<string, AutomationRun[]>(automations.map((item) => [item.summary.id, seedRuns(item)]));

// Follows set_automation_app_enabled: an app turned off isn't asked, so neither it nor its automations show.
let appsOff: AutomationSource[] = [];
const notOff = (apps: AutomationSource[]) => apps.filter((app) => !appsOff.includes(app));

const list = (): AutomationList => ({
  automations: automations.map((item) => item.summary).filter((summary) => !appsOff.includes(summary.source)),
  scans: [
    { machine: 'cam-mbp', scannedAtMs: now - 6 * MINUTE, scanning: false, error: null, apps: notOff(['codexApp', 'claudeDesktop', ...(withSuperset ? ['superset' as const] : []), ...(withOwnUdian ? ['ultradian' as const] : [])]), udian: runnerOn.get('cam-mbp') ?? null, placingError: null },
    {
      machine: 'cedar-02', scannedAtMs: now - 6 * MINUTE, scanning: false, error: null, apps: notOff([...(withOrca ? ['orca' as const] : []), ...(withSuperset ? ['superset' as const] : []), ...(withOwnUdian ? ['ultradian' as const] : [])]), udian: runnerOn.get('cedar-02') ?? null,
      placingError: runner === 'failing' ? 'cedar-02 didn\'t answer over SSH.' : null,
    },
    {
      machine: 'ci-01', scannedAtMs: failing ? now - 3 * HOUR : now - 6 * MINUTE, scanning: false, error: failing ? 'ci-01 didn\'t answer over SSH.' : null, apps: [],
      udian: failing ? null : runnerOn.get('ci-01') ?? null, placingError: null,
    },
  ],
  running,
  draftModel,
  draftEffort,
  udianBundled: BUNDLED_RUNNER,
  udianSkill: BUNDLED_SKILL,
  // The harnesses Arbor can start that some machine has, as `launchable` lists them.
  agents: (['claude', 'codex', 'pi', 'primeAgent', 'droid'] as const).filter((agent) => agent === 'claude' || agent === 'codex' || Boolean(mockHarnessesFound()[agent]?.length)),
  proxyKey,
  proxyAddress,
  appsOff,
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
    if (udianScenario === 'away' && id?.startsWith('ultradian:')) return later(600, () => { throw 'cedar-02 didn\'t answer over SSH.'; });
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
        schedule: choiceSummary(scheduleChoice(input.rrule)), nextRunAtMs: input.enabled ? nextRun(choiceSummary(scheduleChoice(input.rrule)), Date.now()) : null,
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
    item.summary.nextRunAtMs = enabled ? nextRun(item.summary.schedule, Date.now()) : null;
    return list();
  },
  run_automation_now: ({ id }) => {
    mockLog('run_automation_now', { id });
    const item = find(id);
    // As Rust's runner: an Arbor run of Claude or Codex goes through the proxy, and with no Automations key it's
    // recorded as failed straight away rather than started.
    const noKey = item.summary.source === 'arbor' && !proxyKey && (item.summary.agent === 'claude' || item.summary.agent === 'codex');
    const run: AutomationRun = noKey ? {
      id: `${id}:run:now-${Date.now()}`, automationId: id, machine: item.summary.machine ?? 'cedar-02', status: 'failed',
      scheduledAtMs: Date.now(), startedAtMs: Date.now(), finishedAtMs: Date.now(), manual: true,
      precheckExit: null, precheckOutput: null, exitCode: null, sessionId: null,
      error: 'Automations reach your proxy with their own key. Add it in Settings › Machines first',
    } : {
      id: `${id}:run:now-${Date.now()}`, automationId: id, machine: item.summary.machine ?? 'cedar-02', status: 'running',
      scheduledAtMs: Date.now(), startedAtMs: Date.now(), finishedAtMs: null, manual: true,
      precheckExit: item.summary.hasPrecheck ? 0 : null, precheckOutput: item.summary.hasPrecheck ? PRECHECK_OUTPUT[id]?.ran ?? null : null,
      exitCode: null, sessionId: null, error: null,
    };
    runs.set(id, [run, ...(runs.get(id) ?? [])]);
    item.summary.lastRun = { status: run.status, atMs: run.scheduledAtMs };
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
  set_automation_app_enabled: ({ source, enabled }) => {
    mockLog('set_automation_app_enabled', { source, enabled });
    if (source === 'arbor') throw "Arbor's own automations can't be turned off here";
    appsOff = enabled ? appsOff.filter((app) => app !== source) : [...appsOff, source];
    return list();
  },
  set_automation_draft_model: ({ model, effort }) => {
    mockLog('set_automation_draft_model', { model, effort });
    draftModel = model;
    draftEffort = effort;
    return list();
  },
  add_automations_key: () => {
    mockLog('add_automations_key', {});
    proxyKey = true;
    return list();
  },
  set_automation_proxy_address: ({ address }) => {
    mockLog('set_automation_proxy_address', { address });
    const trimmed = address.trim();
    if (trimmed && !/^https?:\/\/\S+$/.test(trimmed)) throw 'Start the address with http:// or https://';
    proxyAddress = trimmed.replace(/\/+$/, '');
    return list();
  },
  open_automation_run_in_terminal: ({ automationId, runId }) => later(300, () => {
    mockLog('open_automation_run_in_terminal', { automationId, runId });
    if (params.get('terminal') === 'fail') throw 'Couldn\'t open Terminal: no application can open the file';
    const run = runs.get(automationId)?.find((entry) => entry.id === runId);
    const item = find(automationId);
    if (item.summary.source === 'ultradian') return `ssh -t cedar-02 'exec "$HOME/.ultradian/bin/udian" logs ${item.summary.name} --run ${runId}'`;
    if (!run?.sessionId) throw 'This run has no session to open';
    const program = item.summary.agent === 'codex' ? `codex resume ${run.sessionId}` : `claude --resume ${run.sessionId}`;
    return `ssh -t ${run.machine ?? 'cedar-02'} '{ cd ${item.projectPath ?? '~'} 2>/dev/null || true; } && exec ${program}'`;
  }),
  install_background_runner: ({ machine: name }) => later(2_500, () => {
    mockLog('install_background_runner', { machine: name });
    const found = runnerOn.get(name);
    if (!found?.target || !BUNDLED_RUNNER) throw 'Arbor has no background runner for this machine\'s system';
    runnerOn.set(name, { ...found, version: BUNDLED_RUNNER, live: true, skill: BUNDLED_SKILL });
    return list();
  }),
};

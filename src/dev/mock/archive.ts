/** The browser mock's answers for the session archive: its store and copies, the machines and old backups it keeps, and its token counts. */
import type { ArchiveCommands } from '../../native/archive';
import type {
  ArchiveCondition,
  ArchiveImport,
  ArchiveMachineRun,
  ArchiveSource,
  ArchiveStatus,
  ArchiveTotals,
  DayRow,
  FolderCheck,
  ImportHomeState,
  ImportPreview,
  ImportPreviewHome,
  LifetimeTokens,
  RecoveredDay,
  MonthRow,
} from '../../native/types';
import type { CommandAnswers } from './answers';
import { later, mockLog, now, params } from './scenario';

const archiveScenario = params.get('archive') ?? 'ok';

const archiveRoot = '/Volumes/Archive/arbor-session-archive.noindex';

// The other machines kept over SSH, by `?archiveMachines=` (listed at the top).
const archiveMachinesScenario = params.get('archiveMachines') ?? 'some';
const archiveProjectsScenario = params.get('archiveProjects');

const fleetRuns = (share: number): ArchiveMachineRun[] => {
  if (archiveMachinesScenario === 'none' || share === 0) return [];
  const runs: ArchiveMachineRun[] = [
    { machine: 'casey-mbp', at: now - 3 * 60_000, complete: false, error: 'ssh: connect to host casey-mbp port 22: Operation timed out', lastOkAt: now - 20 * 60 * 60_000 },
    { machine: 'cedar-02', at: now - 3 * 60_000, complete: true, error: null, lastOkAt: now - 3 * 60_000 },
  ];
  if (archiveMachinesScenario === 'new') runs.push({ machine: 'ci-01', at: now - 3 * 60_000, complete: false, error: 'ssh: Could not resolve hostname ci-01: nodename nor servname provided', lastOkAt: null });
  return runs;
};

const fleetHomes = (share: number): ArchiveSource[] => archiveMachinesScenario === 'none' || share === 0 ? [] : [
  { machine: 'cedar-02', label: '~/.claude', agent: 'claude', files: 3480, kept: 3480, gone: 41, retentionDays: 36_500 },
  { machine: 'cedar-02', label: '~/.codex', agent: 'codex', files: 925, kept: 925, gone: 0, retentionDays: null },
  { machine: 'casey-mbp', label: '~/.codex', agent: 'codex', files: 666, kept: 640, gone: 0, retentionDays: null },
  // Claude's desktop app: an audit log for each local session, and each session's own Claude Code home.
  { machine: 'casey-mbp', label: `${DESKTOP}/acct/org`, agent: 'claude-desktop', files: 96, kept: 96, gone: 0, retentionDays: null },
  ...Array.from({ length: 3 }, (_, n): ArchiveSource => ({ machine: 'casey-mbp', label: `${DESKTOP}/acct/org/local_${n}/.claude`, agent: 'claude', files: 12 + n, kept: 12 + n, gone: 0, retentionDays: null })),
];
const DESKTOP = '~/Library/Application Support/Claude/local-agent-mode-sessions';
const archiveHomes = (share: number): ArchiveSource[] => [
  { machine: 'mac-mini', label: '~/.claude', agent: 'claude', files: 5210, kept: Math.round(5210 * share), gone: share > 0 ? 214 : 0, retentionDays: 36_500 },
  { machine: 'mac-mini', label: '~/.codex', agent: 'codex', files: 1810, kept: Math.round(1810 * share), gone: share > 0 ? 12 : 0, retentionDays: null },
  { machine: 'mac-mini', label: '~/.t3/provider-homes/claude-proxy', agent: 'claude', files: 912, kept: Math.round(912 * share), gone: 0, retentionDays: null },
  { machine: 'mac-mini', label: '~/Library/Application Support/@posthog/posthog-code/claude', agent: 'claude', files: 12, kept: Math.round(12 * share), gone: 0, retentionDays: null },
  ...fleetHomes(share),
];

const archiveTotals = (share: number): ArchiveTotals => ({
  sessions: Math.round(3120 * share), versions: Math.round(3388 * share), files: Math.round(7932 * share),
  storedBytes: Math.round(2.1e9 * share), rawBytes: Math.round(14.6e9 * share), growing: share > 0 ? 6 : 0, pendingBytes: share > 0 ? 3_100_000 : 0,
});

// Old backups taken into the archive, by `?imports=` (listed at the top).
const importsScenario = params.get('imports') ?? 'some';

const importPreviewScenario = params.get('importPreview') ?? 'found';

function mockArchiveImports(scenario: string): ArchiveImport[] {
  if (scenario === 'off' || scenario === 'empty' || importsScenario === 'none') return [];
  const started = now - 3 * 86_400_000;
  return [
    {
      id: 3, path: '/Volumes/Archive/Codex Backups/old-mac', machine: 'mac-mini', machines: ['mac-mini'], homes: 5,
      files: importsScenario === 'starting' ? 0 : 9_034, kept: importsScenario === 'starting' ? 0 : 3_702, sessions: importsScenario === 'starting' ? 0 : 1_880,
      addedAt: now - 20 * 60_000, finishedAt: null, connected: importsScenario !== 'away', failures: 0, error: null,
    },
    {
      id: 2, path: '/Volumes/Archive/Old files/dot-claude', machine: 'mac-mini', machines: ['mac-mini'], homes: 1,
      files: 12_480, kept: importsScenario === 'failed' ? 12_477 : 12_480, sessions: 1_618, addedAt: started, finishedAt: started + 41 * 60_000, connected: true,
      failures: importsScenario === 'failed' ? 3 : 0, error: importsScenario === 'failed' ? 'Couldn’t read a session file: Permission denied (os error 13)' : null,
    },
  ];
}

function mockImportPreview(path: string): ImportPreview {
  const user = `${path}/old-mac/filesystem/Users/casey`;
  const home = (agent: string, root: string, files: number, sessions: number, state: ImportHomeState = 'new', layout = 'home'): ImportPreviewHome =>
    ({ agent, root, layout, state, files, bytes: files * 410_000, sessions });
  const homes = importPreviewScenario === 'none' ? [] : importPreviewScenario === 'kept'
    ? [home('claude', `${path}/dot-claude`, 0, 0, 'imported'), home('claude', '/Users/casey/.claude', 0, 0, 'live')]
    : importPreviewScenario === 'others'
    ? [
        home('openclaw', `${path}/openclaw-agents/main`, 14_061, 6_904, 'new', 'openclaw'),
        home('codex', `${path}/openclaw-agents/main/agent/codex-home`, 4_737, 4_737),
        home('claude-desktop', `${path}/local-agent-mode-sessions/acct/org`, 915, 915, 'new', 'claude-desktop'),
      ]
    : [
        home('codex', `${path}/old-codex/.codex`, 1_240, 1_238),
        home('codex', `${user}/.codex`, 4_517, 4_517),
        home('codex', `${user}/.codex-2`, 210, 210),
        home('claude', `${user}/.skipper/profiles/work2`, 2_925, 331),
        home('claude', `${user}/.t3/provider-homes/claude-proxy`, 9_312, 1_024),
      ];
  const fresh = homes.filter((entry) => entry.state === 'new');
  return {
    path,
    homes,
    sessions: fresh.length ? 6_120 : 0,
    newSessions: fresh.length ? 4_517 : 0,
    files: fresh.reduce((sum, entry) => sum + entry.files, 0),
    bytes: fresh.reduce((sum, entry) => sum + entry.bytes, 0),
    firstAt: fresh.length ? new Date(2026, 0, 6).getTime() : null,
    lastAt: fresh.length ? new Date(2026, 6, 1).getTime() : null,
    partial: importPreviewScenario === 'partial',
    machines: ['mac-mini', 'casey-mbp', 'cedar-02', 'ci-01'],
  };
}

function mockArchiveStatus(scenario: string): ArchiveStatus {
  const share = scenario === 'empty' ? 0 : scenario === 'catching-up' ? 0.41 : 1;
  const connected = scenario !== 'missing' && scenario !== 'foreign';
  if (scenario === 'off') {
    return {
      state: 'off', archiveId: null, main: null, sources: [], machines: [], imports: [], totals: archiveTotals(0),
      running: false, lastPassAt: null, nextPassAt: null, lastError: null, failingSince: null, paused: false, gentle: false, otherMachines: true, machineOverrides: {}, projectOverrides: {}, warnings: [],
    };
  }
  // A missing drive was last reached yesterday, so its alert and banner show; another folder in its place, 3 hours ago.
  const lastSeenAt = now - (scenario === 'missing' ? 26 * 60 : scenario === 'foreign' ? 3 * 60 : 3) * 60_000;
  const conditions: Record<string, ArchiveCondition> = {
    empty: 'catching-up', 'catching-up': 'catching-up', missing: 'main-missing', noowners: 'ok', foreign: 'foreign', error: 'error', paused: 'paused',
  };
  const state = conditions[scenario] ?? 'ok';
  return {
    state,
    archiveId: 'mock-archive',
    main: { root: archiveRoot, connected, mountPoint: connected ? '/Volumes/Archive' : null, freeBytes: connected ? 1_240_000_000_000 : null, noowners: scenario === 'noowners', lastSeenAt },
    sources: archiveHomes(share),
    machines: fleetRuns(share),
    imports: mockArchiveImports(scenario),
    totals: archiveTotals(share),
    running: scenario === 'empty',
    lastPassAt: scenario === 'empty' ? null : now - 3 * 60_000,
    nextPassAt: now + 2 * 60_000,
    lastError: scenario === 'error' ? 'Couldn’t list the agent homes: find: /Users/casey/.codex/sessions: Operation not permitted' : null,
    failingSince: scenario === 'error' ? now - 2 * 60 * 60_000 : null,
    paused: scenario === 'paused',
    gentle: false,
    otherMachines: archiveMachinesScenario !== 'off',
    // `?archiveMachines=own`: ci-01 is left out whatever All machines says.
    machineOverrides: archiveMachinesScenario === 'own' ? { ci01: false } : {},
    // `?archiveProjects=sample`: casey/billing left out everywhere, and casey/arbor left out on ci-01 alone.
    projectOverrides: archiveProjectsScenario === 'sample'
      ? { 'casey/billing': { all: false, machines: {} }, 'casey/arbor': { all: null, machines: { ci01: false } } }
      : {},
    warnings: scenario === 'noowners' ? ['noowners'] : [],
  };
}

function mockFolderCheck(path: string): FolderCheck {
  const kind = path.startsWith('/Users') || path.startsWith('/Library') ? 'same-disk'
    : path.includes('existing') || path.includes('moved') ? 'archive'
    : path.includes('photos') ? 'not-empty'
    : path.startsWith('/Volumes/Archive/') ? 'empty'
    : 'missing';
  const onDrive = kind === 'empty' || kind === 'archive' || kind === 'not-empty';
  return { kind, freeBytes: onDrive ? 1_240_000_000_000 : null, mountPoint: onDrive ? '/Volumes/Archive' : null, noowners: onDrive, archiveId: kind !== 'archive' ? null : path.includes('moved') ? String(archiveStatus.archiveId ?? 'another-archive') : 'another-archive' };
}

// Built after `now`, which the archive's pass times are measured from.
let archiveStatus = mockArchiveStatus(archiveScenario);

// Usage › All time: what the archive has counted, by `?tokens=` (listed at the top).
const tokensScenario = params.get('tokens') ?? 'done';

// Claude Code's own count on days whose transcripts are gone, by `?recovered=` (listed at the top).
const recoveredScenario = params.get('recovered') ?? 'some';

/**
 * cedar-02 and casey-mbp have a stretch six weeks back whose transcripts were cleared before the archive
 * kept them, and mac-mini has days from before the year counted with only a count of sessions.
 */
function mockRecovered(): Pick<LifetimeTokens, 'recovered' | 'recoveredOverlap'> {
  if (recoveredScenario === 'none') return { recovered: [], recoveredOverlap: { claudeCode: 0, transcripts: 0 } };
  const pad = (value: number) => String(value).padStart(2, '0');
  const ago = (days: number) => {
    const day = new Date(now);
    day.setDate(day.getDate() - days);
    return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  };
  const recovered: RecoveredDay[] = [
    ...Array.from({ length: 10 }, (_, n): RecoveredDay => ({ day: ago(52 - n), machine: 'cedar-02', tokens: Math.round((0.55 + 0.45 * Math.abs(Math.sin(n * 7.1))) * 1.5e9), sessions: 3 + (n % 4) })),
    ...Array.from({ length: 7 }, (_, n): RecoveredDay => ({ day: ago(48 - n), machine: 'casey-mbp', tokens: Math.round((0.5 + 0.5 * Math.abs(Math.sin(n * 3.3))) * 3.2e8), sessions: 1 + (n % 3) })),
    ...Array.from({ length: 29 }, (_, n): RecoveredDay => ({ day: ago(480 - n * 3), machine: 'mac-mini', tokens: 0, sessions: 1 + (n % 5) })),
  ];
  return { recovered: recovered.sort((left, right) => left.day.localeCompare(right.day)), recoveredOverlap: { claudeCode: 176_400_000_000, transcripts: 100_200_000_000 } };
}

function mockLifetimeTokens(): LifetimeTokens {
  const archived = archiveScenario !== 'off';
  const counted = archived && archiveScenario !== 'empty' && tokensScenario !== 'waiting';
  // Who made the calls, and in which months: an older Claude model hands over to a newer one in May.
  const makers = [
    { home: '~/.claude', agent: 'claude', model: 'claude-opus-4-6', weight: 0.46, until: '2026-05' },
    { home: '~/.claude', agent: 'claude', model: 'claude-opus-5-5', weight: 0.5, from: '2026-05' },
    { home: '~/.claude', agent: 'claude', model: 'claude-haiku-4-5-20251001', weight: 0.03 },
    { home: '~/.t3/provider-homes/claude-proxy', agent: 'claude', model: 'claude-sonnet-5', weight: 0.14, from: '2026-02' },
    { home: '~/.codex', agent: 'codex', model: 'gpt-5.5-codex', weight: 0.2, until: '2026-07' },
    { home: '~/.codex', agent: 'codex', model: 'gpt-6-sol', weight: 0.24, from: '2026-07' },
    { home: '~/.codex', agent: 'codex', model: '', weight: 0.004 },
    // An OpenClaw agent's own calls, from an old backup.
    { home: '/Volumes/Archive/Old files/openclaw-agents/main', agent: 'openclaw', model: 'gpt-5.5', weight: 0.01, from: '2026-04', until: '2026-06' },
  ];
  const months = new Map<string, MonthRow>();
  const days: DayRow[] = [];
  const pad = (value: number) => String(value).padStart(2, '0');
  const start = new Date(new Date(now).getFullYear() - 1, new Date(now).getMonth(), 1);
  for (let day = new Date(start), index = 0; day.getTime() <= now; day.setDate(day.getDate() + 1), index += 1) {
    const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    const month = key.slice(0, 7);
    // Use grows through the year, dips at weekends and wobbles from day to day.
    const scale = (0.35 + (index / 365) * 1.3) * (day.getDay() === 0 || day.getDay() === 6 ? 0.45 : 1) * (0.75 + 0.5 * Math.abs(Math.sin(index * 12.9898)));
    const today: DayRow = { day: key, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
    for (const maker of makers) {
      if ((maker.from && month < maker.from) || (maker.until && month > maker.until)) continue;
      const tokens = 2.6e9 * scale * maker.weight;
      const codex = maker.agent === 'codex';
      const counts: Record<Exclude<keyof DayRow, 'day'>, number> = {
        calls: Math.round(tokens / 118_000),
        input: Math.round(tokens * (codex ? 0.05 : 0.004)),
        cacheWrite: Math.round(tokens * (codex ? 0.003 : 0.045)),
        cacheRead: Math.round(tokens * (codex ? 0.93 : 0.94)),
        output: Math.round(tokens * (codex ? 0.017 : 0.011)),
        reasoning: codex ? Math.round(tokens * 0.009) : 0,
      };
      const rowKey = `${month}|${maker.home}|${maker.model}`;
      const row: MonthRow = months.get(rowKey) ?? { month, machine: 'mac-mini', home: maker.home, agent: maker.agent, model: maker.model, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0 };
      for (const field of Object.keys(counts) as (keyof typeof counts)[]) {
        row[field] += counts[field];
        today[field] += counts[field];
      }
      months.set(rowKey, row);
    }
    days.push(today);
  }
  return {
    archived,
    months: counted ? [...months.values()] : [],
    days: counted ? days : [],
    sources: archived
      ? [
          ...archiveHomes(1).map((home) => ({ machine: home.machine, home: home.label, agent: home.agent, kind: 'home' })),
          ...mockArchiveImports(archiveScenario).filter((entry) => entry.finishedAt !== null).map((entry) => ({ machine: entry.machine, home: entry.path, agent: 'claude', kind: 'import' })),
        ]
      : [],
    ...(counted ? mockRecovered() : { recovered: [], recoveredOverlap: { claudeCode: 0, transcripts: 0 } }),
    versionsLeft: tokensScenario === 'counting' ? 214 : 0,
    bytesLeft: tokensScenario === 'counting' ? 3_240_000_000 : 0,
    lastError: tokensScenario === 'failed' ? 'Couldn’t read a kept chunk: No such file or directory (os error 2)' : null,
  };
}

/** Makes a new archive in an empty folder, or takes up the one a folder holds already. */
const openArchive = (command: 'create_session_archive' | 'use_session_archive', path: string) => {
  mockLog(command, { path });
  return later(700, () => {
    const check = mockFolderCheck(path);
    if (command === 'create_session_archive' && check.kind !== 'empty') throw 'That folder has other things in it. Choose an empty one.';
    // Finding a moved archive carries on with what it holds; a new or adopted one starts catching up.
    const found = archiveStatus.archiveId !== null ? 'ok' : 'empty';
    archiveStatus = { ...mockArchiveStatus(found), main: { root: path, connected: true, mountPoint: '/Volumes/Archive', freeBytes: 1_240_000_000_000, noowners: true, lastSeenAt: Date.now() }, warnings: ['noowners'] };
    return archiveStatus;
  });
};

/** The session archive, its imports and the tokens it counts. */
export const archiveAnswers: CommandAnswers<ArchiveCommands> = {
  get_session_archive_status: () => archiveStatus,
  get_lifetime_tokens: () => mockLifetimeTokens(),
  check_session_archive_folder: (args) => later(200, () => mockFolderCheck(args.path)),
  create_session_archive: (args) => openArchive('create_session_archive', args.path),
  use_session_archive: (args) => openArchive('use_session_archive', args.path),
  run_session_archive_now: () => {
    mockLog('run_session_archive_now', {});
    window.setTimeout(() => { archiveStatus = { ...archiveStatus, running: true }; }, 400);
    window.setTimeout(() => { archiveStatus = { ...archiveStatus, running: false, lastPassAt: Date.now(), nextPassAt: Date.now() + 5 * 60_000 }; }, 1500);
    return null;
  },
  set_session_archive_paused: (args) => {
    const { paused } = args;
    archiveStatus = { ...archiveStatus, paused, state: paused ? 'paused' : 'ok' };
    return archiveStatus;
  },
  save_session_archive_settings: (args) => {
    archiveStatus = { ...archiveStatus, gentle: args.gentle, otherMachines: args.otherMachines };
    return archiveStatus;
  },
  set_session_archive_machine: (args) => {
    const key = args.machine.toLowerCase().replace(/[^a-z0-9]/g, '');
    const machineOverrides = { ...archiveStatus.machineOverrides };
    if (args.keep === null) delete machineOverrides[key];
    else machineOverrides[key] = args.keep;
    archiveStatus = { ...archiveStatus, machineOverrides };
    return archiveStatus;
  },
  set_session_archive_project: (args) => {
    const key = args.project.trim().toLowerCase();
    const machine = args.machine?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? null;
    const current = archiveStatus.projectOverrides[key] ?? { all: null, machines: {} };
    const machines = { ...current.machines };
    if (machine !== null) {
      if (args.keep === null) delete machines[machine];
      else machines[machine] = args.keep;
    }
    const next = { all: machine === null ? args.keep : current.all, machines };
    const projectOverrides = { ...archiveStatus.projectOverrides };
    if (next.all === null && !Object.keys(machines).length) delete projectOverrides[key];
    else projectOverrides[key] = next;
    archiveStatus = { ...archiveStatus, projectOverrides };
    return archiveStatus;
  },
  reveal_session_archive: () => { mockLog('reveal_session_archive', {}); return null; },
  preview_session_import: (args) => {
    return later(importPreviewScenario === 'slow' ? 4_000 : 700, () => {
      if (importPreviewScenario === 'fail') throw 'That folder isn’t there.';
      return mockImportPreview(args.path);
    });
  },
  add_session_import: (args) => {
    mockLog('add_session_import', args);
    const { path } = args;
    const found = mockImportPreview(path).homes;
    const imports = archiveStatus.imports;
    const id = Math.max(0, ...imports.map((entry) => entry.id)) + 1;
    const machine = args.machine;
    const added = { id, path, machine, machines: [machine], homes: found.length, files: 0, kept: 0, sessions: 0, addedAt: Date.now(), finishedAt: null, connected: true, failures: 0, error: null };
    archiveStatus = { ...archiveStatus, imports: [added, ...imports] };
    // The next check lists it and keeps a first share.
    window.setTimeout(() => {
      archiveStatus = { ...archiveStatus, imports: archiveStatus.imports.map((entry) => entry.id === id ? { ...entry, files: 18_204, kept: 2_310, sessions: 540 } : entry) };
    }, 2_500);
    return archiveStatus;
  },
  cancel_session_import: (args) => {
    mockLog('cancel_session_import', args);
    const imports = archiveStatus.imports;
    if (!imports.some((entry) => entry.id === args.id && entry.finishedAt === null)) throw 'That import has finished already.';
    archiveStatus = { ...archiveStatus, imports: imports.filter((entry) => entry.id !== args.id) };
    return archiveStatus;
  },
};

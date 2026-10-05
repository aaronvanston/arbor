import { invokeCommand } from '../native/commands';
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { formatWhen } from '../lib/format';
import { machineLookKey } from './machineLook';
import type { SystemNotification } from './notify';
import type {
  ArchiveCondition,
  ArchiveImport,
  ArchiveMachineRun,
  ArchiveSource,
  ArchiveStatus,
  ArchiveTotals,
  FolderCheck,
  ImportPreview,
} from '../native/types';

/**
 * The session archive: a byte-for-byte copy of every Claude Code and Codex
 * session, every version of it, in a folder on another drive. The backend
 * reports ids, paths, counts and sizes only, never what a session says.
 */

export const getSessionArchiveStatus = () => invokeCommand('get_session_archive_status');

/** Every machine the archive files sessions under: its homes', the other machines' passes and its imports'. */
export function archiveMachines(status: Pick<ArchiveStatus, 'sources' | 'machines' | 'imports'>): string[] {
  return [...new Set([
    ...status.sources.map((source) => source.machine),
    ...status.machines.map((run) => run.machine),
    ...status.imports.flatMap((entry) => [entry.machine, ...entry.machines]),
  ].filter(Boolean))];
}
export const checkSessionArchiveFolder = (path: string) => invokeCommand('check_session_archive_folder', { path });
export const createSessionArchive = (path: string) => invokeCommand('create_session_archive', { path });
export const adoptSessionArchive = (path: string) => invokeCommand('use_session_archive', { path });
export const runSessionArchiveNow = () => invokeCommand('run_session_archive_now');
export const setSessionArchivePaused = (paused: boolean) => invokeCommand('set_session_archive_paused', { paused });
/** Keeps one machine's sessions or not whatever All machines says, or with null puts it back on All machines' value. */
export const setSessionArchiveMachine = (machine: string, keep: boolean | null) =>
  invokeCommand('set_session_archive_machine', { machine, keep });
/**
 * Keeps a project's sessions or not, on every machine (`machine` null) or on one, whatever the machine says; null puts
 * it back on what it inherits. Leaving a project out stops new copies; what's already kept stays.
 */
export const setSessionArchiveProject = (project: string, machine: string | null, keep: boolean | null) =>
  invokeCommand('set_session_archive_project', { project, machine, keep });
export type ArchiveSwitches = { gentle: boolean; otherMachines: boolean };
export const saveSessionArchiveSettings = (settings: ArchiveSwitches) =>
  invokeCommand('save_session_archive_settings', settings);

/**
 * Saves the archive's two switches, which go to the backend together. Each save carries every change asked for so far
 * and waits for the one before it: a switch flipped while the other's save was out would otherwise send the status's
 * old value for the first, and put it back.
 */
export function archiveSwitchSaver(save: (settings: ArchiveSwitches) => Promise<ArchiveStatus> = saveSessionArchiveSettings) {
  let wanted: ArchiveSwitches | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  return (current: ArchiveSwitches, change: Partial<ArchiveSwitches>): Promise<ArchiveStatus> => {
    const settings = { ...(wanted ?? current), ...change };
    wanted = settings;
    const run = queue.then(() => save(settings));
    // Once the newest change is saved, or failed, the status reads true again.
    const settle = () => { if (wanted === settings) wanted = null; };
    queue = run.then(settle, settle);
    return run;
  };
}
export const revealSessionArchive = () => invokeCommand('reveal_session_archive');
export const previewSessionImport = (path: string) => invokeCommand('preview_session_import', { path });
export const addSessionImport = (path: string, machine: string) => invokeCommand('add_session_import', { path, machine });
export const cancelSessionImport = (id: number) => invokeCommand('cancel_session_import', { id });

/** Claude Code homes keeping sessions this long or longer aren't deleting them. */
const LONG_RETENTION_DAYS = 3_650;

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'muted';

export function archiveTone(state: ArchiveCondition): Tone {
  switch (state) {
    case 'ok': return 'success';
    case 'catching-up': return 'info';
    case 'paused':
    case 'main-missing': return 'warning';
    case 'foreign':
    case 'error': return 'error';
    case 'off': return 'muted';
  }
}

export const archiveStateKey = (state: ArchiveCondition): MessageKey => `sessionArchive.state.${state}`;

/** What choosing a folder would do: make an archive there, use the one there, or neither and why. */
export type FolderVerdict = { action: 'create' | 'use' | null; key: MessageKey };

export function folderVerdict(check: FolderCheck, archiveId: string | null): FolderVerdict {
  switch (check.kind) {
    case 'empty':
      return archiveId ? { action: null, key: 'sessionArchive.folder.alreadyHaveOne' } : { action: 'create', key: 'sessionArchive.folder.empty' };
    case 'archive':
      return archiveId && check.archiveId !== archiveId
        ? { action: null, key: 'sessionArchive.folder.otherArchive' }
        : { action: 'use', key: archiveId ? 'sessionArchive.folder.ours' : 'sessionArchive.folder.archive' };
    case 'not-empty': return { action: null, key: 'sessionArchive.folder.notEmpty' };
    case 'missing': return { action: null, key: 'sessionArchive.folder.missing' };
    case 'not-writable': return { action: null, key: 'sessionArchive.folder.notWritable' };
  }
}

/**
 * Whether the archive keeps a machine's sessions: this Mac's always, another's by its own value or else All machines'.
 * False with no archive, or before its status is read.
 */
export function archiveKeepsMachine(status: ArchiveStatus | null, machine: { machine: string; local: boolean }): boolean {
  if (!status || status.state === 'off') return false;
  if (machine.local) return true;
  return status.machineOverrides[machineLookKey(machine.machine)] ?? status.otherMachines;
}

/** How many times smaller the store is than what it holds, to one decimal, or null before anything's kept. */
export function compression(totals: ArchiveTotals): number | null {
  if (totals.storedBytes <= 0 || totals.rawBytes <= 0) return null;
  return Math.round((totals.rawBytes / totals.storedBytes) * 10) / 10;
}

/** What Claude Code keeps sessions for when a home doesn't say. */
const CLAUDE_DEFAULT_RETENTION_DAYS = 30;

/** Days until Claude Code deletes a home's untouched sessions, when that's soon enough to matter. */
export function deletesAfterDays(source: ArchiveSource): number | null {
  if (source.agent !== 'claude') return null;
  const days = source.retentionDays ?? CLAUDE_DEFAULT_RETENTION_DAYS;
  return days < LONG_RETENTION_DAYS ? days : null;
}

export type MachineGroup = { machine: string; sources: ArchiveSource[]; run: ArchiveMachineRun | null };

/**
 * A machine's homes with the Claude Code homes a desktop app keeps for its local sessions, which can run to a hundred,
 * folded into the row of the folder of session logs they're in.
 */
function foldDesktopSessions(sources: ArchiveSource[]): ArchiveSource[] {
  const folders = sources.filter((source) => source.agent === 'claude-desktop').map((source) => source.label);
  const folded = new Map<string, ArchiveSource>();
  const rows: ArchiveSource[] = [];
  for (const source of sources) {
    const folder = source.agent === 'claude-desktop' ? source.label : folders.find((label) => source.label.startsWith(`${label}/`));
    if (folder === undefined) {
      rows.push(source);
      continue;
    }
    let row = folded.get(folder);
    if (!row) {
      row = { ...source, label: folder, agent: 'claude-desktop', files: 0, kept: 0, gone: 0, retentionDays: null };
      folded.set(folder, row);
      rows.push(row);
    }
    row.files += source.files;
    row.kept += source.kept;
    row.gone += source.gone;
  }
  return rows;
}

/**
 * Homes grouped by machine, in listing order, each with its machine's last pass. A machine that
 * has been tried but has nothing kept yet gets a group of its own, to say why.
 */
export function sourcesByMachine(sources: ArchiveSource[], runs: ArchiveMachineRun[] = []): MachineGroup[] {
  const groups = new Map<string, ArchiveSource[]>();
  for (const source of sources) groups.set(source.machine, [...(groups.get(source.machine) ?? []), source]);
  for (const run of runs) if (!groups.has(run.machine)) groups.set(run.machine, []);
  return [...groups].map(([machine, list]) => ({ machine, sources: foldDesktopSessions(list), run: runs.find((run) => run.machine === machine) ?? null }));
}

/** Where an import has got to: finished, waiting for its drive, not listed yet, or partway. */
export type ImportProgress =
  | { kind: 'done' }
  | { kind: 'away' }
  | { kind: 'starting' }
  | { kind: 'importing'; share: number };

export function importProgress(item: ArchiveImport): ImportProgress {
  if (item.finishedAt !== null) return { kind: 'done' };
  if (!item.connected) return { kind: 'away' };
  if (item.files === 0) return { kind: 'starting' };
  return { kind: 'importing', share: Math.min(1, item.kept / item.files) };
}

/** Why a previewed folder can't be imported (nothing in it, or all of it kept already), or null when it can. */
export function importBlocker(preview: ImportPreview): MessageKey | null {
  if (preview.homes.length === 0) return 'sessionArchive.imports.preview.none';
  if (!preview.homes.some((home) => home.state === 'new')) return 'sessionArchive.imports.preview.allKept';
  return null;
}

/** A home found in a backup, named from the folder chosen: its path inside it, or its own name when it's the folder. */
export function importHomeName(root: string, folder: string): string {
  if (root.startsWith(`${folder}/`)) return root.slice(folder.length + 1);
  return root === folder ? root.split('/').filter(Boolean).pop() ?? root : root;
}

/**
 * Why the archive isn't keeping sessions, when that isn't the user's choice: its drive is away, another folder is
 * where it was, or passes are failing. Sessions that change meanwhile are kept once it's back; ones deleted first aren't.
 */
export type ArchiveTrouble = { kind: 'away' | 'foreign' | 'failing'; since: number | null };

export function archiveTrouble(status: ArchiveStatus): ArchiveTrouble | null {
  switch (status.state) {
    case 'main-missing': return { kind: 'away', since: status.main?.lastSeenAt ?? null };
    case 'foreign': return { kind: 'foreign', since: status.main?.lastSeenAt ?? null };
    case 'error': return { kind: 'failing', since: status.failingSince };
    default: return null;
  }
}

/**
 * How long the archive can be away or failing before it's worth an alert, so moving the drive or a bad pass says nothing.
 * Notifications settings and the phone topic say "an hour".
 */
export const ARCHIVE_ALERT_AFTER_MS = 60 * 60_000;
/** While it stays that way, the alert comes again this often. */
export const ARCHIVE_REMIND_EVERY_MS = 24 * 60 * 60_000;

/** What the monitor keeps between checks: the trouble it's following, since when, and when it last said so. */
export type ArchiveAlertState = { kind: ArchiveTrouble['kind']; since: number; alertedAt: number | null } | null;
export type ArchiveAlert = { kind: ArchiveTrouble['kind']; since: number };

/** The state after a check, and the alert that's due, if one is. */
export function nextArchiveAlert(state: ArchiveAlertState, trouble: ArchiveTrouble | null, nowMs: number): { state: ArchiveAlertState; alert: ArchiveAlert | null } {
  if (!trouble) return { state: null, alert: null };
  const same = state?.kind === trouble.kind ? state : null;
  // The last time the store was reached says how long it's been away. Failing is timed only since Arbor started,
  // so a start noted before a restart is kept.
  const since = trouble.kind !== 'failing' && trouble.since !== null ? trouble.since : Math.min(trouble.since ?? nowMs, same?.since ?? nowMs);
  const alertedAt = same?.alertedAt ?? null;
  const due = nowMs - since >= ARCHIVE_ALERT_AFTER_MS && (alertedAt === null || nowMs - alertedAt >= ARCHIVE_REMIND_EVERY_MS);
  return { state: { kind: trouble.kind, since, alertedAt: due ? nowMs : alertedAt }, alert: due ? { kind: trouble.kind, since } : null };
}

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

/** The alert for an archive that's been away or failing a while. What failed stays on the Mac: it can name paths. */
export function archiveNotification(alert: ArchiveAlert, status: ArchiveStatus, nowMs: number, t: Translate): SystemNotification {
  const time = formatWhen(alert.since, { now: nowMs });
  switch (alert.kind) {
    case 'away':
      return { title: t('sessionArchive.alert.away.title'), body: t('sessionArchive.alert.away.body', { time }), kind: 'archiveAway' };
    case 'foreign':
      return { title: t('sessionArchive.alert.foreign.title'), body: t('sessionArchive.alert.foreign.body', { time }), kind: 'archiveAway' };
    case 'failing':
      return {
        title: t('sessionArchive.alert.failing.title'),
        body: status.lastError ? t('sessionArchive.alert.failing.body', { time, error: status.lastError }) : t('sessionArchive.alert.failing.phone', { time }),
        phoneBody: t('sessionArchive.alert.failing.phone', { time }),
        kind: 'archiveFailing',
      };
  }
}

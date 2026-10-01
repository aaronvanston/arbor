import { describe, expect, it } from 'bun:test';
import {
  ARCHIVE_ALERT_AFTER_MS,
  ARCHIVE_REMIND_EVERY_MS,
  archiveMachines,
  archiveKeepsMachine,
  archiveNotification,
  archiveTrouble,
  compression,
  deletesAfterDays,
  folderVerdict,
  nextArchiveAlert,
  sourcesByMachine,
  type ArchiveAlertState,
  type ArchiveTrouble,
} from '../src/services/sessionArchive';
import { translate } from '../src/i18n';
import { itemAt } from './support/items';
import type { MessageKey, MessageVariables } from '../src/i18n/resources';
import type { ArchiveSource, ArchiveStatus, FolderCheck } from '../src/native/types';

const check = (kind: FolderCheck['kind'], archiveId: string | null = null): FolderCheck => ({ kind, ownDisk: false, freeBytes: 1e12, mountPoint: '/Volumes/Backup', noowners: false, archiveId });
const source = (fields: Partial<ArchiveSource>): ArchiveSource => ({ machine: 'mini', label: '~/.claude', agent: 'claude', files: 10, kept: 10, gone: 0, retentionDays: 36_500, ...fields });
const t = (key: MessageKey, variables?: MessageVariables) => translate(key, variables);
const HOUR = 60 * 60_000;
const status = (fields: Partial<ArchiveStatus> = {}): ArchiveStatus => ({
  state: 'ok',
  archiveId: 'a1',
  main: { root: '/Volumes/Backup/arbor-session-archive.noindex', connected: true, mountPoint: '/Volumes/Backup', freeBytes: 1e12, noowners: false, lastSeenAt: 1_000 },
  sources: [],
  machines: [],
  imports: [],
  totals: { sessions: 0, versions: 0, files: 0, storedBytes: 0, rawBytes: 0, growing: 0, pendingBytes: 0 },
  running: false,
  lastPassAt: null,
  nextPassAt: null,
  lastError: null,
  failingSince: null,
  paused: false,
  gentle: false,
  otherMachines: true,
  machineOverrides: {},
  projectOverrides: {},
  warnings: [],
  ...fields,
});

describe('the session archive', () => {
  it('lists every machine it files sessions under once, for All time’s picker', () => {
    const imports = [{ machine: 'old-mbp', machines: ['old-mbp', 'lab-box'] }] as unknown as ArchiveStatus['imports'];
    const machines = [{ machine: 'cedar' }, { machine: '' }] as unknown as ArchiveStatus['machines'];
    expect(archiveMachines(status({ sources: [source({}), source({ label: '~/.codex' })], machines, imports }))).toEqual(['mini', 'cedar', 'old-mbp', 'lab-box']);
    expect(archiveMachines(status())).toEqual([]);
  });

  it('makes an archive only in an empty folder, and uses only its own', () => {
    expect(folderVerdict(check('empty'), null)).toEqual({ action: 'create', key: 'sessionArchive.folder.empty' });
    // One archive per Mac: with one already kept, an empty folder isn't a place to start another.
    expect(folderVerdict(check('empty'), 'ours').action).toBeNull();
    expect(folderVerdict(check('archive', 'ours'), 'ours')).toEqual({ action: 'use', key: 'sessionArchive.folder.ours' });
    expect(folderVerdict(check('archive', 'found'), null)).toEqual({ action: 'use', key: 'sessionArchive.folder.archive' });
    expect(folderVerdict(check('archive', 'other'), 'ours')).toEqual({ action: null, key: 'sessionArchive.folder.otherArchive' });
    for (const kind of ['not-empty', 'missing', 'not-writable'] as const) {
      const verdict = folderVerdict(check(kind), null);
      expect(verdict.action).toBeNull();
    }
  });

  it('keeps this Mac always, and another machine by its own value or else All machines’', () => {
    const mac = { machine: 'mac-mini', local: true };
    const ci = { machine: 'ci-01', local: false };
    expect([archiveKeepsMachine(null, mac), archiveKeepsMachine(status({ state: 'off' }), mac)]).toEqual([false, false]);
    expect([archiveKeepsMachine(status(), mac), archiveKeepsMachine(status(), ci)]).toEqual([true, true]);
    const onlyThisMac = status({ otherMachines: false });
    expect([archiveKeepsMachine(onlyThisMac, mac), archiveKeepsMachine(onlyThisMac, ci)]).toEqual([true, false]);
    expect(archiveKeepsMachine(status({ otherMachines: false, machineOverrides: { ci01: true } }), ci)).toBe(true);
    expect(archiveKeepsMachine(status({ machineOverrides: { ci01: false } }), ci)).toBe(false);
  });

  it('says how much smaller the store is, once there is one', () => {
    const totals = { sessions: 1, versions: 1, files: 1, storedBytes: 0, rawBytes: 0, growing: 0, pendingBytes: 0 };
    expect(compression(totals)).toBeNull();
    expect(compression({ ...totals, storedBytes: 2.1e9, rawBytes: 14.6e9 })).toBe(7);
  });

  it('warns about Claude Code homes that delete sessions, including ones that never said', () => {
    expect(deletesAfterDays(source({ retentionDays: 36_500 }))).toBeNull();
    expect(deletesAfterDays(source({ retentionDays: 14 }))).toBe(14);
    // Claude Code keeps 30 days when a home doesn't say.
    expect(deletesAfterDays(source({ retentionDays: null }))).toBe(30);
    expect(deletesAfterDays(source({ agent: 'codex', retentionDays: null }))).toBeNull();
  });

  it('groups homes by machine in the order they came', () => {
    const groups = sourcesByMachine([source({ machine: 'mini', label: 'a' }), source({ machine: 'air', label: 'b' }), source({ machine: 'mini', label: 'c' })]);
    expect(groups.map((group) => [group.machine, group.sources.map((item) => item.label)])).toEqual([['mini', ['a', 'c']], ['air', ['b']]]);
    // A machine tried but never reached still gets a group, to say why; each group has its machine's last pass.
    const air = { machine: 'air', at: 2_000, complete: false, error: 'ssh: timed out', lastOkAt: 1_000 };
    const cedar = { machine: 'cedar', at: 2_000, complete: false, error: 'ssh: no route', lastOkAt: null };
    const tried = sourcesByMachine([source({ machine: 'mini', label: 'a' }), source({ machine: 'air', label: 'b' })], [air, cedar]);
    expect(tried.map((group) => [group.machine, group.sources.length, group.run?.error ?? null])).toEqual([['mini', 1, null], ['air', 1, 'ssh: timed out'], ['cedar', 0, 'ssh: no route']]);
  });

  it('folds the homes of a desktop app’s local sessions into the folder of logs they’re in', () => {
    const desktop = '~/Library/Application Support/Claude/local-agent-mode-sessions';
    const groups = sourcesByMachine([
      source({ machine: 'air', label: '~/.claude' }),
      source({ machine: 'air', label: `${desktop}/acct/org`, agent: 'claude-desktop', files: 2, kept: 2, retentionDays: null }),
      source({ machine: 'air', label: `${desktop}/acct/org/local_a/.claude`, files: 3, kept: 1, gone: 1, retentionDays: null }),
      source({ machine: 'air', label: '~/.codex', agent: 'codex' }),
      source({ machine: 'air', label: `${desktop}/acct/org/local_b/.claude`, files: 4, kept: 4 }),
    ]);
    const rows = itemAt(groups, 0).sources;
    expect(rows.map((row) => [row.label, row.agent, row.files, row.kept, row.gone])).toEqual([
      ['~/.claude', 'claude', 10, 10, 0],
      [`${desktop}/acct/org`, 'claude-desktop', 9, 7, 1],
      ['~/.codex', 'codex', 10, 10, 0],
    ]);
    // Claude Code's 30-day cleanup isn't what removes them, so no warning says it is.
    expect(deletesAfterDays(itemAt(rows, 1))).toBeNull();
  });

  it('counts only trouble the owner didn’t choose', () => {
    expect(archiveTrouble(status({ state: 'main-missing' }))).toEqual({ kind: 'away', since: 1_000 });
    expect(archiveTrouble(status({ state: 'foreign' }))).toEqual({ kind: 'foreign', since: 1_000 });
    expect(archiveTrouble(status({ state: 'error', failingSince: 5_000 }))).toEqual({ kind: 'failing', since: 5_000 });
    for (const state of ['off', 'ok', 'catching-up', 'paused'] as const) expect(archiveTrouble(status({ state }))).toBeNull();
  });

  it('alerts after an hour away, then once a day while it lasts', () => {
    const away: ArchiveTrouble = { kind: 'away', since: 0 };
    let state: ArchiveAlertState = null;
    const step = (trouble: ArchiveTrouble | null, now: number) => {
      const next = nextArchiveAlert(state, trouble, now);
      state = next.state;
      return next.alert;
    };
    // Unplugged to move the drive: nothing.
    expect(step(away, ARCHIVE_ALERT_AFTER_MS - 1)).toBeNull();
    expect(step(away, ARCHIVE_ALERT_AFTER_MS)).toEqual({ kind: 'away', since: 0 });
    expect(step(away, ARCHIVE_ALERT_AFTER_MS + 5 * 60_000)).toBeNull();
    expect(step(away, ARCHIVE_ALERT_AFTER_MS + ARCHIVE_REMIND_EVERY_MS)).toEqual({ kind: 'away', since: 0 });
    // Back, then away again: a new spell, timed from when the drive was last reached.
    expect(step(null, 30 * HOUR)).toBeNull();
    expect(state).toBeNull();
    expect(step({ kind: 'away', since: 30 * HOUR }, 30 * HOUR + 5 * 60_000)).toBeNull();
    expect(step({ kind: 'away', since: 30 * HOUR }, 31 * HOUR)).toEqual({ kind: 'away', since: 30 * HOUR });
    // Arbor started long after the drive went: the alert comes on the first look.
    expect(nextArchiveAlert(null, { kind: 'away', since: 0 }, 72 * HOUR).alert).toEqual({ kind: 'away', since: 0 });
  });

  it('times failing from its first sighting, across a restart that forgot it', () => {
    const before = nextArchiveAlert(null, { kind: 'failing', since: 0 }, 10 * 60_000).state;
    // After a restart the backend only knows passes have failed since it started.
    const after = nextArchiveAlert(before, { kind: 'failing', since: 50 * 60_000 }, HOUR);
    expect(after.alert).toEqual({ kind: 'failing', since: 0 });
    // A different trouble starts over.
    expect(nextArchiveAlert(after.state, { kind: 'away', since: 55 * 60_000 }, HOUR).alert).toBeNull();
  });

  it('keeps what failed off the phone, and every alert opens the archive', () => {
    const failing = status({ state: 'error', lastError: 'Couldn’t list /Users/casey/.codex/sessions', failingSince: 0 });
    const alert = archiveNotification({ kind: 'failing', since: 0 }, failing, HOUR, t);
    expect(alert.kind).toBe('archiveFailing');
    expect(alert.body).toContain('Couldn’t list /Users/casey/.codex/sessions');
    expect(alert.phoneBody).not.toContain('/Users/casey');
    expect(alert.phoneBody).toContain('Settings › Session archive');
    const away = archiveNotification({ kind: 'away', since: 0 }, status({ state: 'main-missing' }), HOUR, t);
    expect(away.kind).toBe('archiveAway');
    expect(away.title).toBe('Session archive drive isn’t connected');
    expect(away.body).toContain('sessions deleted before then won’t be kept');
    expect(archiveNotification({ kind: 'foreign', since: 0 }, status({ state: 'foreign' }), HOUR, t).kind).toBe('archiveAway');
  });
});

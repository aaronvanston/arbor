import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { clearMocks } from '@tauri-apps/api/mocks';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockCommands } from '../src/dev/mock/answers';
import { I18nProvider, translate, translateRich } from '../src/i18n';
import { outcomeText } from '../src/pages/SetupSync';
import { CleanupContent, type CleanupProblem } from '../src/pages/MachineCleanup';
import { allArchived, archiveLine, cleanupView, deleteSetAside, removalAsks, removeCleanup, restoreSetAside } from '../src/services/cleanup';
import { readCommandError } from '../src/services/commandError';
import type { CleanupHome, CleanupScan, HomeArchive, SetAsideItem } from '../src/native/types';
import { itemAt } from './support/items';

const home = (path: string, more: Partial<CleanupHome> = {}): CleanupHome => ({
  path, agent: 'droid', harness: 'droid', role: 'history', sizeKb: 1_000, newestMs: 1, lastSessionMs: null, sessionFiles: 0, installed: false, inside: null,
  ownSessions: null, ownSessionsArchived: false, held: null, archive: null, ...more,
});

const standing = (more: Partial<HomeArchive> = {}): HomeArchive => ({ sessions: 1_284, notArchived: 0, blocked: null, lastPassMs: 2, newerThanPass: false, ...more });

const aside = (path: string, more: Partial<SetAsideItem> = {}): SetAsideItem => ({
  stamp: '20261007T010203Z-00aa', item: 0, group: 'cache', path, atMs: 1_790_000_000_000, sizeKb: 2_048, volume: null, taken: false, ...more,
});

const scan = (more: Partial<CleanupScan> = {}): CleanupScan => ({
  machine: 'cam-mbp', scannedAtMs: 1, homes: [], agents: [], leftovers: [], caches: [], aside: [], partial: false, ...more,
});

function render(found: CleanupScan | null, more: { problem?: CleanupProblem; looking?: boolean; error?: string } = {}) {
  const noop = () => undefined;
  const wrap = (node: ReactNode) => <I18nProvider>{node}</I18nProvider>;
  return renderToStaticMarkup(wrap(
    <CleanupContent
      machine="cam-mbp"
      pill="cam-mbp"
      scan={found}
      looking={more.looking ?? false}
      error={more.error ?? null}
      busy={null}
      problem={more.problem ?? null}
      onLook={noop}
      onRemove={noop}
      onRestore={noop}
      onDelete={noop}
    />,
  ));
}

describe('a machine’s clean-up', () => {
  it('lists each group biggest first and counts only what can come off now', () => {
    const view = cleanupView(scan({
      homes: [home('~/.factory', { sizeKb: 10 }), home('~/.claude', { agent: 'claude', harness: 'claude', sizeKb: 9_000, held: 'unmeasured' }), home('~/.config/amp', { sizeKb: 500 })],
      caches: [{ harness: 'claude', kind: 'logs', path: '~/.claude/debug', home: '~/.claude', sizeKb: 4_000, newestMs: 1, held: null }],
      aside: [aside('~/.codex/log', { atMs: 1 }), aside('~/.cache/opencode', { atMs: 2, sizeKb: 1_000 })],
    }));
    expect(view.homes.map((entry) => entry.path)).toEqual(['~/.claude', '~/.config/amp', '~/.factory']);
    expect([view.removable, view.removableKb]).toEqual([3, 4_510]);
    expect(view.aside.map((entry) => entry.path)).toEqual(['~/.cache/opencode', '~/.codex/log']);
    expect(view.asideKb).toBe(3_048);
    expect(cleanupView(scan()).empty).toBe(true);
  });

  it('asks before looking, and says when there is nothing to clean', () => {
    expect(render(null)).toContain('See what could come off');
    expect(render(scan())).toContain('Nothing to clean up on');
    expect(render(null, { error: 'ssh: timed out' })).toContain('Arbor couldn’t look: ssh: timed out');
  });

  it('says on each home with sessions how much of them the archive holds', () => {
    const html = render(scan({ homes: [
      home('~/.claude', { agent: 'claude', harness: 'claude', archive: standing({ notArchived: 312 }) }),
      home('~/.codex', { agent: 'codex', harness: 'codex', archive: standing({ sessions: 342 }) }),
      home('~/.old-claude', { agent: 'claude', harness: 'claude', archive: standing({ notArchived: 61, sessions: 61, blocked: 'off' }) }),
      home('~/.factory'),
    ] }));
    const row = (path: string) => itemAt(html.split('data-cleanup-path=').filter((entry) => entry.startsWith(`"${path}"`)), 0);
    expect(row('~/.claude')).toContain('312 of 1,284 session files not archived yet');
    expect(row('~/.codex')).toContain('All 342 session files archived');
    expect(row('~/.old-claude')).toContain('Session archive is off');
    expect(row('~/.factory')).not.toContain('data-archive-standing');
    // Every one of them can be removed now; the ones not all archived ask first.
    for (const path of ['~/.claude', '~/.codex', '~/.old-claude']) expect(row(path)).not.toContain('aria-disabled="true"');
  });

  it('asks before setting aside a home with sessions not all archived, or one an agent still runs from', () => {
    expect(allArchived(standing())).toBe(true);
    expect(allArchived(standing({ newerThanPass: true }))).toBe(false);
    expect(archiveLine(standing({ newerThanPass: true })).key).toBe('machine.cleanup.archive.newer');
    expect(archiveLine(standing({ blocked: 'notKept', notArchived: 1_284 })).key).toBe('machine.cleanup.archive.notKept');
    expect(removalAsks({ role: 'history', archive: standing() })).toBeNull();
    expect(removalAsks({ role: 'history', archive: standing({ notArchived: 3 }) })).toEqual({ unarchived: true, active: false });
    expect(removalAsks({ role: 'active', archive: standing() })).toEqual({ unarchived: false, active: true });
    expect(removalAsks({ role: 'active', archive: null })).toBeNull();
  });

  it('says what sessions a removable home takes along, only where the catalog knows its sessions folder', () => {
    const html = render(scan({ homes: [
      home('~/.pi/agent', { agent: 'pi-agent', harness: 'pi', ownSessions: '~/.pi/agent/sessions', ownSessionsArchived: true }),
      home('~/.old-pi', { agent: 'pi-agent', harness: 'pi', ownSessions: '~/.old-pi/sessions' }),
      home('~/.factory'),
    ] }));
    const row = (path: string) => itemAt(html.split('data-cleanup-path=').filter((entry) => entry.startsWith(`"${path}"`)), 0);
    expect(row('~/.pi/agent')).toContain('Holds ~/.pi/agent/sessions, Pi’s sessions, which Arbor archives.');
    expect(row('~/.pi/agent')).not.toContain('aria-disabled="true"');
    expect(row('~/.old-pi')).toContain('May hold Pi’s own sessions, which Arbor doesn’t archive.');
    expect(row('~/.factory')).not.toContain('sessions,');
  });

  it('says which folders of a clean-up were deleted for good when Undo puts back the rest', () => {
    const text = (failed: { path: string; reason: string }[], done: string[]) =>
      renderToStaticMarkup(<I18nProvider>{outcomeText({ backup: null, done, failed }, 'cam-mbp', translate, translateRich).text}</I18nProvider>);
    const partly = outcomeText({ backup: null, done: ['~/.claude/debug'], failed: [{ path: '~/.factory', reason: 'deleted' }] }, 'cam-mbp', translate, translateRich);
    expect(partly.ok).toBe(true);
    expect(text([{ path: '~/.factory', reason: 'deleted' }], ['~/.claude/debug'])).toContain('~/.factory was deleted for good');
  });

  it('lists what is set aside with Restore, Delete for good and the drive it is kept on', () => {
    const html = render(scan({ aside: [aside('~/Scratch/old-agent', { group: 'home', volume: '~/Scratch' }), aside('~/.codex/log', { item: 1, taken: true })] }));
    expect(html).toContain('Delete all for good');
    expect(html).toContain('kept on ~/Scratch');
    const taken = itemAt(html.split('data-cleanup-path=').filter((row) => row.startsWith('"~/.codex/log"')), 0);
    expect(taken).toContain('Something is in its place now');
  });

  it('offers Refresh beside a refusal because something changed since the look', () => {
    const html = render(scan({ homes: [home('~/.factory')] }), { problem: { key: '~/.factory', text: '~/.factory changed since Arbor looked', changed: true } });
    expect(html).toContain('changed since Arbor looked');
    expect(html).toContain('>Refresh</button>');
  });

});

describe('a machine’s clean-up, on the machine', () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  });
  afterEach(() => {
    clearMocks();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('passes what to remove, put back and delete to the machine, and reads a refusal by its kind', async () => {
    const calls = mockCommands({
      remove_cleanup_items: () => {
        throw { kind: 'changed', message: '~/.factory changed since Arbor looked, so nothing was moved. Refresh and try again.' };
      },
      restore_set_aside: () => ({ restored: ['~/.factory'], failed: [], scan: scan() }),
      delete_set_aside: () => scan(),
    });
    const refused = await removeCleanup('cam-mbp', [{ group: 'home', path: '~/.factory' }]).catch((reason: unknown) => readCommandError(reason));
    expect(refused).toMatchObject({ kind: 'changed' });
    await restoreSetAside('cam-mbp', '20261007T010203Z-00aa');
    await deleteSetAside('cam-mbp', [aside('~/.codex/log', { item: 3 })]);
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ['remove_cleanup_items', { machine: 'cam-mbp', items: [{ group: 'home', path: '~/.factory' }], allowUnarchived: false }],
      ['restore_set_aside', { machine: 'cam-mbp', stamp: '20261007T010203Z-00aa', item: null }],
      ['delete_set_aside', { machine: 'cam-mbp', items: [{ stamp: '20261007T010203Z-00aa', item: 3 }] }],
    ]);
  });
});

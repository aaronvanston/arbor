import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { ArchiveImports, ImportPreviewBody, ImportRow } from '../src/pages/SessionArchiveImports';
import { importBlocker, importHomeName, importProgress } from '../src/services/sessionArchive';
import type { ArchiveImport, ArchiveStatus, ImportPreview } from '../src/native/types';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const item = (fields: Partial<ArchiveImport> = {}): ArchiveImport => ({
  id: 1,
  path: '/Volumes/Backup/Mac backups/old-mac',
  machine: 'mini',
  machines: ['mini'],
  homes: 5,
  files: 9_034,
  kept: 3_702,
  sessions: 1_880,
  addedAt: new Date(2026, 8, 20).getTime(),
  finishedAt: null,
  connected: true,
  failures: 0,
  error: null,
  ...fields,
});
const preview = (fields: Partial<ImportPreview> = {}): ImportPreview => ({
  path: '/Volumes/Backup/Mac backups',
  homes: [
    { agent: 'codex', root: '/Volumes/Backup/Mac backups/b1/filesystem/Users/me/.codex', layout: 'home', state: 'new', files: 4_517, bytes: 3.1e9, sessions: 4_517 },
    { agent: 'claude', root: '/Users/me/.claude', layout: 'home', state: 'live', files: 0, bytes: 0, sessions: 0 },
    { agent: 'claude', root: '/Volumes/Backup/Mac backups/dot-claude', layout: 'home', state: 'imported', files: 0, bytes: 0, sessions: 0 },
  ],
  sessions: 4_517,
  newSessions: 4_100,
  files: 4_517,
  bytes: 3.1e9,
  firstAt: new Date(2026, 0, 6).getTime(),
  lastAt: new Date(2026, 6, 1).getTime(),
  partial: false,
  machines: ['mini', 'cedar-02'],
  ...fields,
});
const row = (fields: Partial<ArchiveImport> = {}, paused = false) =>
  text(renderToStaticMarkup(<I18nProvider><ImportRow item={item(fields)} paused={paused} onStop={() => undefined} /></I18nProvider>));
const bodyOf = (shown: ImportPreview) =>
  text(renderToStaticMarkup(<I18nProvider><ImportPreviewBody preview={shown} machine="mini" onMachine={() => undefined} /></I18nProvider>));
const body = (fields: Partial<ImportPreview> = {}) => bodyOf(preview(fields));

describe('Session archive › Old backups', () => {
  it('says how far an import has got', () => {
    expect(importProgress(item())).toEqual({ kind: 'importing', share: 3_702 / 9_034 });
    expect(importProgress(item({ files: 0, kept: 0 }))).toEqual({ kind: 'starting' });
    expect(importProgress(item({ connected: false }))).toEqual({ kind: 'away' });
    // A finished import stays finished with its drive unplugged.
    expect(importProgress(item({ connected: false, finishedAt: Date.now() }))).toEqual({ kind: 'done' });
  });

  it('shows each import with what to do about it', () => {
    const importing = row();
    expect(importing).toContain('From mini , 5 places with sessions');
    expect(importing).toContain('3,702 of 9,034 files kept so far (41%)');
    expect(importing).toContain('Stop');
    expect(row({ connected: false })).toContain('Its drive isn’t connected. The import carries on when it is.');
    expect(row({ files: 0, kept: 0 })).toContain('Starts with the next check');
    expect(row({ files: 0, kept: 0 }, true)).toContain('Starts when you resume keeping sessions');
    const done = row({ homes: 1, finishedAt: new Date(2026, 8, 21).getTime(), kept: 9_034, failures: 3, error: 'Couldn’t read a session file' });
    expect(done).toContain('From mini , 1 place with sessions');
    // An import filed under more than one machine shows each as its pill.
    expect(row({ machines: ['air', 'mini'] })).toContain('From air mini , 5 places');
    expect(done).toMatch(/Finished (21 Sep|Sep 21): 1,880 sessions in 9,034 files/);
    expect(done).toContain('3 files couldn’t be read');
    expect(done).toContain('Couldn’t read a session file');
    expect(done).toContain('Done');
    expect(done).not.toContain('Stop');
  });

  it('offers a first import when there are none', () => {
    const status = { imports: [], paused: false } as unknown as ArchiveStatus;
    const shown = text(renderToStaticMarkup(<I18nProvider><ArchiveImports status={status} onStatus={() => undefined} /></I18nProvider>));
    expect(shown).toContain('Old backups');
    expect(shown).toContain('Import a backup…');
    expect(shown).toContain('No backups imported');
  });

  it('previews what a folder would bring in before anything is taken', () => {
    expect(importBlocker(preview())).toBeNull();
    const shown = body();
    expect(shown).toContain('4,517');
    expect(shown).toContain('4,100 not kept yet');
    expect(shown).toMatch(/Session files last changed (6 Jan – 1 Jul|Jan 6 – Jul 1)/);
    // Homes are named from inside the folder chosen; ones kept already say so and aren't counted.
    expect(shown).toContain('b1/filesystem/Users/me/ .codex');
    expect(shown).not.toContain('Mac backups/b1');
    expect(shown).toContain('One of this Mac’s homes, kept already');
    expect(shown).toContain('Imported already');
    expect(shown).toContain('Came from');
    expect(shown).not.toContain('stopped looking');
    expect(body({ partial: true })).toContain('Arbor stopped looking before it had looked everywhere');
  });

  it('says why a folder has nothing to import', () => {
    const none = preview({ homes: [], sessions: 0, newSessions: 0, files: 0, bytes: 0, firstAt: null, lastAt: null });
    expect(importBlocker(none)).toBe('sessionArchive.imports.preview.none');
    expect(body({ homes: [] })).toContain('There’s nothing in this folder Arbor can import.');
    const kept = preview({ homes: preview().homes.filter((home) => home.state !== 'new') });
    expect(importBlocker(kept)).toBe('sessionArchive.imports.preview.allKept');
    expect(body({ homes: kept.homes })).toContain('Everything in this folder is kept already.');
    expect(body({ homes: kept.homes })).not.toContain('Came from');
  });

  it('names the other kinds of backup it finds', () => {
    const others = preview({
      path: '/Volumes/Backup/Moved',
      homes: [
        { agent: 'openclaw', root: '/Volumes/Backup/Moved/openclaw-agents/main', layout: 'openclaw', state: 'new', files: 14_000, bytes: 1.7e9, sessions: 7_000 },
        { agent: 'claude-desktop', root: '/Volumes/Backup/Moved/local-agent-mode-sessions/a/b', layout: 'claude-desktop', state: 'new', files: 915, bytes: 3e8, sessions: 915 },
      ],
    });
    const shown = bodyOf(others);
    expect(shown).toContain('OpenClaw');
    expect(shown).toContain('Claude desktop');
    expect(shown).toContain('Came from');
  });

  it('names a home from the folder it was found in', () => {
    expect(importHomeName('/Volumes/Backup/b/.codex', '/Volumes/Backup/b')).toBe('.codex');
    expect(importHomeName('/Volumes/Backup/dot-claude', '/Volumes/Backup/dot-claude')).toBe('dot-claude');
    // Found above the folder chosen (its projects/ was chosen): the whole path.
    expect(importHomeName('/Volumes/Backup/dot-claude', '/Volumes/Backup/dot-claude/projects')).toBe('/Volumes/Backup/dot-claude');
    expect(importHomeName('/Volumes/Backup/bb', '/Volumes/Backup/b')).toBe('/Volumes/Backup/bb');
  });
});

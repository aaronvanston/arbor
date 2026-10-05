import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { ArchiveBannerView } from '../src/components/ArchiveBanner';
import { ArchiveOverview, ArchiveSetup } from '../src/pages/SessionArchiveSettings';
import { setSettingsProject, setSettingsScope } from '../src/services/machineSettings';
import type { ArchiveStatus } from '../src/native/types';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const status = (fields: Partial<ArchiveStatus> = {}): ArchiveStatus => ({
  state: 'ok',
  archiveId: 'a1',
  main: { root: '/Volumes/Backup/arbor-session-archive.noindex', connected: true, mountPoint: '/Volumes/Backup', freeBytes: 1.24e12, noowners: false, lastSeenAt: Date.now() - 3 * 60_000 },
  sources: [
    { machine: 'mini', label: '~/.claude', agent: 'claude', files: 5210, kept: 5210, gone: 214, retentionDays: 36_500 },
    { machine: 'mini', label: '~/.agent-app/homes/claude-other', agent: 'claude', files: 912, kept: 400, gone: 0, retentionDays: null },
  ],
  machines: [],
  imports: [],
  totals: { sessions: 3120, versions: 3388, files: 7932, storedBytes: 2.1e9, rawBytes: 14.6e9, growing: 6, pendingBytes: 3e6 },
  running: false,
  lastPassAt: Date.now() - 3 * 60_000,
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
const overview = (fields: Partial<ArchiveStatus> = {}) => text(renderToStaticMarkup(<I18nProvider><ArchiveOverview status={status(fields)} onStatus={() => undefined} /></I18nProvider>));

describe('Settings › Session archive', () => {
  it('asks for a folder when there is no archive yet, suggesting none', () => {
    const off = status({ state: 'off', archiveId: null, main: null, sources: [] });
    const html = renderToStaticMarkup(<I18nProvider><ArchiveSetup status={off} onStatus={() => undefined} /></I18nProvider>);
    expect(html).toContain('value=""');
    expect(text(html)).toContain('Keep every session');
    expect(text(html)).toContain('Create archive');
    expect(html).toContain('aria-label="Archive folder"');
  });

  it('shows how keeping sessions is going, what is kept and each home', () => {
    const shown = overview();
    expect(shown).toContain('Up to date');
    // The page's clock ticks by the minute, so it may be a minute behind.
    expect(shown).toMatch(/Checked [23]m ago/);
    expect(shown).toContain('/Volumes/Backup/arbor-session-archive.noindex');
    expect(shown).toContain('1.1 TB free on the drive');
    expect(shown).toContain('3,120');
    expect(shown).toContain('6 still growing');
    expect(shown).toContain('13.6 GB of sessions, 7× smaller');
    expect(shown).toContain('Agent homes on mini');
    expect(shown).toContain('5,210 of 5,210 files kept');
    expect(shown).toContain('214 deleted since, still kept');
    // A home that never said how long to keep sessions loses them after Claude Code's 30 days.
    expect(shown).toContain('Claude Code deletes sessions here after 30 days');
    expect(shown).toContain('400 of 912 files kept Claude Code deletes sessions here after 30 days Catching up');
  });

  it('keeps the other machines too, and says when one couldn’t be reached', () => {
    const shown = overview({
      sources: [
        ...status().sources,
        { machine: 'cedar-01', label: '~/.claude', agent: 'claude', files: 3480, kept: 3480, gone: 0, retentionDays: 36_500 },
        { machine: 'macbook-air', label: '~/.codex', agent: 'codex', files: 666, kept: 640, gone: 0, retentionDays: null },
      ],
      machines: [
        { machine: 'cedar-01', at: Date.now(), complete: true, error: null, lastOkAt: Date.now() },
        { machine: 'macbook-air', at: Date.now(), complete: false, error: 'ssh: connect to host macbook-air port 22: Operation timed out', lastOkAt: Date.now() - 20 * 60 * 60_000 },
        { machine: 'cedar-02', at: Date.now(), complete: false, error: 'ssh: Could not resolve hostname cedar-02', lastOkAt: null },
      ],
    });
    expect(shown).toContain('Keep other machines’ sessions');
    expect(shown).toContain('Agent homes on cedar-01');
    expect(shown).toContain('3,480 of 3,480 files kept');
    // The page's clock ticks by the minute, so it may be a minute behind.
    expect(shown).toMatch(/The last check didn’t finish\. macbook-air didn’t answer over SSH\. Check that it’s on and connected\. Last kept (19|20)h ago\./);
    // One never reached has no homes yet, only why.
    expect(shown).toContain('Agent homes on cedar-02');
    expect(shown).toContain('The last check didn’t finish. Couldn’t find cedar-02 on the network. Check its name in your SSH config. Nothing kept from it yet.');
    expect(shown.match(/The last check didn’t finish/g)?.length).toBe(2);
  });

  it('keeps or leaves out a project’s sessions, on every machine or on one', () => {
    const checked = (html: string) => html.match(/role="switch"[^>]*aria-checked="(true|false)"|aria-checked="(true|false)"[^>]*role="switch"/)?.slice(1).find(Boolean);
    const render = (fields: Partial<ArchiveStatus>) => renderToStaticMarkup(<I18nProvider><ArchiveOverview status={status(fields)} onStatus={() => undefined} /></I18nProvider>);
    const projectOverrides = { 'cam/billing': { all: false, machines: {} }, 'cam/arbor': { all: null, machines: { ci01: false } } };
    try {
      setSettingsProject('cam/billing');
      const billing = render({ projectOverrides });
      expect(text(billing)).toContain('Keep this project’s sessions');
      expect(text(billing)).toContain('what’s kept already stays');
      expect(checked(billing)).toBe('false');
      // The archive's own rows are the same for every project.
      expect(text(billing)).not.toContain('Show in Finder');

      // Nearest wins: arbor is left out on ci-01 alone, and kept everywhere else, this Mac included.
      setSettingsProject('cam/arbor');
      setSettingsScope('ci-01');
      expect(checked(render({ projectOverrides }))).toBe('false');
      setSettingsScope('cedar-02');
      expect(checked(render({ projectOverrides }))).toBe('true');
      // A project on a machine that isn't kept follows the machine until it's given a value.
      expect(checked(render({ projectOverrides, otherMachines: false }))).toBe('false');
    } finally {
      setSettingsProject(null);
      setSettingsScope(null);
    }
  });

  it('says what to do in every state', () => {
    const missing = overview({ state: 'main-missing', main: { root: '/Volumes/Backup/a.noindex', connected: false, mountPoint: null, freeBytes: null, noowners: false, lastSeenAt: null } });
    expect(missing).toContain('Connect the archive’s drive and Arbor carries on where it left off.');
    expect(missing).toContain('The drive isn’t connected.');
    // A moved archive can be found again; there's nothing to show in Finder until it is.
    expect(missing).toContain('Find archive…');
    expect(missing).not.toContain('Show in Finder');
    expect(overview()).toContain('Show in Finder');
    expect(overview({ state: 'paused', paused: true })).toContain('Paused');
    expect(overview({ state: 'foreign' })).toContain('Wrong drive');
    expect(overview({ state: 'catching-up' })).toContain('Catching up');
    expect(overview({ state: 'error', lastError: 'Couldn’t list the agent homes' })).toContain('Having trouble');
    expect(overview({ state: 'error', lastError: 'Couldn’t list the agent homes' })).toContain('Couldn’t list the agent homes');
    expect(overview({ running: true })).toContain('Checking now…');
    const noowners = overview({ warnings: ['noowners'], main: { root: '/Volumes/Backup/a.noindex', connected: true, mountPoint: '/Volumes/Backup', freeBytes: 1e12, noowners: true, lastSeenAt: null } });
    expect(noowners).toContain('Anyone on this Mac can read it');
    expect(noowners).toContain('sudo diskutil enableOwnership /Volumes/Backup');
  });

  it('puts a banner on Sessions only while sessions aren’t being archived', () => {
    const banner = (fields: Partial<ArchiveStatus>) => text(renderToStaticMarkup(<I18nProvider><ArchiveBannerView status={status(fields)} onOpen={() => undefined} /></I18nProvider>));
    for (const state of ['off', 'ok', 'catching-up', 'paused'] as const) expect(banner({ state })).toBe('');
    const away = banner({ state: 'main-missing', main: { root: '/Volumes/Backup/a.noindex', connected: false, mountPoint: null, freeBytes: null, noowners: false, lastSeenAt: Date.now() - 26 * 60 * 60_000 } });
    expect(away).toContain('Sessions aren’t being archived');
    expect(away).toContain('The archive’s drive hasn’t been connected since');
    expect(away).toContain('Open session archive');
    const failing = banner({ state: 'error', lastError: 'Couldn’t list the agent homes', failingSince: Date.now() - 2 * 60 * 60_000 });
    expect(failing).toContain('The archive has been failing since');
    expect(failing).toContain('Couldn’t list the agent homes');
    expect(banner({ state: 'foreign' })).toContain('The archive’s folder has held something else since');
  });
});

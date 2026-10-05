import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../src/i18n';
import { BackupList } from '../src/pages/SetupSync';
import type { SetupBackup } from '../src/native/types';

const backup = (id: string, what: SetupBackup['what'], files: string[], undone = false): SetupBackup => ({
  id,
  atMs: Date.UTC(2026, 8, 26, 1, 2, 3),
  what,
  commit: null,
  undoneAtMs: undone ? Date.UTC(2026, 8, 26, 2, 0, 0) : null,
  files: files.map((path) => ({ path, change: 'changed', skill: false })),
  skills: [],
});

const render = (backups: SetupBackup[], limit?: number) =>
  renderToStaticMarkup(
    <I18nProvider>
      <BackupList machine="cam-mbp" backups={backups} error={null} busy={false} undoing={null} onUndo={() => {}} limit={limit} />
    </I18nProvider>,
  );

describe('the list of changes Arbor made on a machine', () => {
  it('says what made each change and how many files it touched', () => {
    const html = render([
      backup('a', 'reporter', ['~/.claude/settings.json', '~/.codex/config.toml']),
      backup('b', 'keepSessions', ['~/.claude/settings.json'], true),
    ]);
    expect(html).toContain('Needs-you reporter · 2 files');
    expect(html).toContain('Keeping sessions · 1 file');
    // An undone change can't be undone twice.
    expect(html.match(/Undo<\/button>/g)?.length).toBe(1);
  });

  it('shows every backup the machine keeps on the changes tab, and the latest few elsewhere', () => {
    const many = Array.from({ length: 20 }, (_, index) => backup(`b${index}`, 'telemetry', ['~/.claude/settings.json']));
    expect(render(many).match(/Telemetry · /g)?.length).toBe(5);
    expect(render(many, 20).match(/Telemetry · /g)?.length).toBe(20);
  });
});

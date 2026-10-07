import { describe, expect, it } from 'bun:test';
import { en } from '../src/i18n/locales/en';
import { alertDestinationView } from '../src/alertNavigation';
import { alertDestination } from '../src/services/alertHistory';
import { appliedText, autoLineNotification, autoLineWords, isPaused } from '../src/services/setupAutoline';
import { present } from './support/items';
import type { AutoLine, AutoLineEvent } from '../src/native/types';

const t = (key: keyof typeof en, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce((text, [name, value]) => text.split(`{${name}}`).join(String(value)), en[key] as string);
const event = (fields: Partial<AutoLineEvent>): AutoLineEvent =>
  ({ machine: 'cam-mbp', kind: 'applied', applied: { files: 0, skills: 0, hooks: 0, mcp: 0 }, error: null, waiting: 0, ...fields });

describe('machines brought in line by themselves', () => {
  it('says what a run did, quietly, and opens that machine’s History', () => {
    expect(appliedText({ files: 3, skills: 1, hooks: 0, mcp: 0 }, t)).toBe('3 files, 1 skill');
    const alert = present(autoLineNotification(event({ applied: { files: 3, skills: 1, hooks: 0, mcp: 0 } }), t));
    expect([alert.title, alert.kind, alert.subject]).toEqual(['Brought cam-mbp in line: 3 files, 1 skill', 'setupAuto', { machine: 'cam-mbp' }]);
    const view = alertDestinationView(present(alertDestination({ kind: 'setupAuto', subject: alert.subject })));
    expect(view).toEqual({ kind: 'main', page: 'setup', params: { tab: 'repo', lens: 'changes', machine: 'cam-mbp' } });
    // A run that changed nothing says nothing.
    expect(autoLineNotification(event({}), t)).toBeNull();
  });

  it('says when a run failed and stopped, and what waits for the user, which opens Overview', () => {
    const failed = present(autoLineNotification(event({ kind: 'failed', error: '~/.claude/CLAUDE.md (changed)' }), t));
    expect(failed.kind).toBe('setupAutoFailed');
    expect(failed.body).toContain('stops doing it by itself there');
    const waiting = present(autoLineNotification(event({ kind: 'waiting', waiting: 2 }), t));
    expect(waiting.title).toBe('2 changes on cam-mbp wait for you');
    expect(alertDestinationView(present(alertDestination({ kind: 'setupWaiting', subject: waiting.subject })))).toEqual({ kind: 'main', page: 'setup', params: { tab: 'overview' } });
    expect(autoLineNotification(event({ kind: 'waiting', waiting: 0 }), t)).toBeNull();
  });

  it('says each machine’s standing in a few words', () => {
    const line: AutoLine = { enabled: true, machines: [
      { machine: 'cam-mbp', paused: false, running: false, lastRunMs: 1_000, lastApplied: null, stopped: null, waiting: 0 },
      { machine: 'ci-01', paused: true, running: false, lastRunMs: null, lastApplied: null, stopped: null, waiting: 0 },
      { machine: 'cedar-02', paused: false, running: false, lastRunMs: null, lastApplied: null, stopped: 'refused', waiting: 0 },
    ] };
    const ago = () => '4m ago';
    expect(autoLineWords(line, 'cam-mbp', ago, t)).toBe('Kept in line automatically · last run 4m ago');
    expect(autoLineWords(line, 'ci-01', ago, t)).toBe('Kept in line by hand: paused here');
    expect(autoLineWords(line, 'cedar-02', ago, t)).toContain('after a run failed (refused)');
    expect(autoLineWords(line, 'lab-box', ago, t)).toBe('Kept in line automatically');
    expect(autoLineWords({ ...line, enabled: false }, 'cam-mbp', ago, t)).toBeNull();
    expect([isPaused(line, 'ci-01'), isPaused(line, 'cam-mbp')]).toEqual([true, false]);
  });
});

describe('saying when something’s wrong', () => {
  it('says a machine behind for a day, which opens Overview, and a setup scan failing, which opens the machine', () => {
    const behind = present(autoLineNotification(event({ kind: 'behindLong', machine: 'cedar-02', waiting: 6 }), t));
    expect([behind.title, behind.kind]).toEqual(['cedar-02 has been behind the setup repo for a day', 'setupBehind']);
    expect(alertDestinationView(present(alertDestination({ kind: 'setupBehind', subject: behind.subject })))).toEqual({ kind: 'main', page: 'setup', params: { tab: 'overview' } });
    const failing = present(autoLineNotification(event({ kind: 'scanFailing', machine: 'ci-01', error: 'Operation timed out' }), t));
    expect([failing.kind, failing.body.endsWith('Operation timed out')]).toEqual(['setupScanFailing', true]);
    expect(alertDestinationView(present(alertDestination({ kind: 'setupScanFailing', subject: failing.subject })))).toEqual({ kind: 'main', page: 'machines', params: { machine: 'ci-01' } });
  });
});

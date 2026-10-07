import { describe, expect, it } from 'bun:test';
import { translate } from '../src/i18n';
import { bringToast, machinesChangedText, repoValueToast, switchFailureText, switchToast, undoToast } from '../src/services/switchReport';

const t = (key: Parameters<typeof translate>[0], variables?: Parameters<typeof translate>[1]) => translate(key, variables, {});

describe('a Library change’s toast', () => {
  it('only says it’s done when every machine it tried changed, and names the ones that didn’t', () => {
    expect(switchToast('guard', 'guard is off on every machine', { changed: ['cam-mbp'], failed: [] }, t)).toEqual({ kind: 'success', title: 'guard is off on every machine' });
    // Nothing to change anywhere is still done.
    expect(switchToast('guard', 'guard is off on every machine', { changed: [], failed: [] }, t).kind).toBe('success');
    expect(switchToast('guard', 'done', { changed: ['cam-mbp'], failed: [{ machine: 'ci-01', message: 'x' }, { machine: 'ci-01', message: 'y' }] }, t))
      .toEqual({ kind: 'warning', title: 'guard changed, but not on ci-01' });
    expect(switchToast('review', 'done', { changed: [], failed: [{ machine: 'cam-mbp', message: 'x' }, { machine: 'ci-01', message: 'y' }] }, t))
      .toEqual({ kind: 'error', title: 'review didn’t change on cam-mbp, ci-01' });
  });

  it('says what a machine refused in words, never the bare reason or a program’s raw text', () => {
    expect(switchFailureText({ machine: 'ci-01', message: 'changed', reason: 'changed', paths: ['~/.claude/settings.json'] }, t))
      .toBe('~/.claude/settings.json changed since Arbor last read it, so Arbor left it alone. Scan the machine again, then try again.');
    expect(switchFailureText({ machine: 'ci-01', message: 'failed', reason: 'failed', paths: ['~/.claude/CLAUDE.md'] }, t)).toBe('Arbor couldn’t write ~/.claude/CLAUDE.md.');
    expect(switchFailureText({ machine: 'ci-01', message: 'unread', reason: 'unread' }, t)).toBe('Arbor hasn’t read this machine yet. Scan it, then try again.');
    expect(switchFailureText({ machine: 'cam-mbp', message: 'plugin `review` was not found in marketplace `team`' }, t))
      .toBe('Codex couldn’t find review in the team marketplace. Check that the machine has that marketplace and that it’s up to date.');
    expect(switchFailureText({ machine: 'cam-mbp', message: 'Error: something else' }, t)).toBe('something else.');
  });
});

describe('how many machines a change reached', () => {
  it('claims a commit only for a change that went into the repo', () => {
    expect(machinesChangedText(2, true, t)).toBe('Committed to the repo, and 2 machines changed.');
    // A plugin update or a marketplace refresh only runs on the machines.
    expect(machinesChangedText(1, false, t)).toBe('1 machine changed.');
    expect(machinesChangedText(3, false, t)).toBe('3 machines changed.');
  });
});

describe('a repo value set from Per home', () => {
  it('says it was committed and offers Undo, and the Undo’s own toast has none', () => {
    let undone = 0;
    const saved = repoValueToast('superpowers', false, () => { undone += 1; }, t);
    expect(saved).toMatchObject({ kind: 'success', title: 'Saved the repo’s value for superpowers', description: 'Committed to the repo.' });
    saved.action?.onClick();
    expect(undone).toBe(1);
    expect(repoValueToast('superpowers', true, () => undefined, t)).toEqual({ kind: 'success', title: 'superpowers is back as it was' });
  });
});

describe('an Undo’s toast', () => {
  it('is back as it was only when everything went back', () => {
    expect(undoToast('guard', { failed: [] }, t)).toEqual({ kind: 'success', title: 'guard is back as it was' });
    expect(undoToast('guard', { failed: [{ machine: 'ci-01', message: 'changed', reason: 'changed', paths: ['~/.claude/settings.json'] }] }, t))
      .toEqual({ kind: 'error', title: 'Couldn’t put guard back on ci-01' });
    expect(undoToast('release-notes', { failed: [], repoError: "Error: The repo has changes to release-notes that aren't committed. Commit or drop them, then try again." }, t))
      .toEqual({ kind: 'error', title: "Couldn’t take release-notes back out of the repo: The repo has changes to release-notes that aren't committed. Commit or drop them, then try again." });
  });
});

describe('bringing machines in line', () => {
  it('names the machines that aren’t in line yet instead of saying they are', () => {
    expect(bringToast(['ci-01'], [], true, t).title).toBe('ci-01 is in line with the repo');
    expect(bringToast(['ci-01'], ['ci-01'], false, t)).toMatchObject({ kind: 'error', title: 'ci-01 isn’t in line with the repo yet' });
    expect(bringToast(['cam-mbp', 'ci-01'], ['ci-01'], true, t)).toMatchObject({ kind: 'warning', title: 'ci-01 isn’t in line with the repo yet' });
    expect(bringToast(['cam-mbp', 'ci-01'], ['cam-mbp', 'ci-01'], false, t).title).toBe('cam-mbp, ci-01 aren’t in line with the repo yet');
  });
});

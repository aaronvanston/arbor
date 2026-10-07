/**
 * How a Sync change that walks machines is reported: each machine's failure in plain words, and a title that says what
 * actually happened, never a success while a machine was left as it was.
 */
import type { MessageKey, MessageVariables } from '../i18n/resources';
import { switchVerdict, type SwitchFailure, type UndoResult } from './libraryToggle';
import { plainError } from './plainError';

type Translate = (key: MessageKey, variables?: MessageVariables) => string;

const REASON_TEXT: Record<NonNullable<SwitchFailure['reason']>, MessageKey> = {
  changed: 'library.failure.changed',
  failed: 'library.failure.failed',
  deleted: 'library.failure.deleted',
  unread: 'library.failure.unread',
};

/** What a machine said, as a sentence: a refused file change by its reason, anything else through plainError. */
export function switchFailureText(failure: SwitchFailure, t: Translate): string {
  if (failure.reason) return t(REASON_TEXT[failure.reason], { paths: (failure.paths ?? []).join(', ') });
  return plainError(failure.message, t);
}

export type SwitchToast = { kind: 'success' | 'warning' | 'error'; title: string };

/**
 * How many machines a change reached, for a toast's description. `committed` when the change also went into the setup
 * repo; a plugin update or a marketplace refresh only touches the machines, so it mustn't claim a commit.
 */
export function machinesChangedText(count: number, committed: boolean, t: Translate): string {
  if (committed) return t(count === 1 ? 'library.toggle.machines.one' : 'library.toggle.machines.other', { count });
  return t(count === 1 ? 'library.machinesChanged.one' : 'library.machinesChanged.other', { count });
}

/**
 * A change's toast: `done` when every machine it tried changed, the machines it failed on otherwise. Made on none of
 * them, it's an error that stays until dismissed.
 */
export function switchToast(name: string, done: string, run: { changed: string[]; failed: SwitchFailure[] }, t: Translate): SwitchToast {
  const { verdict, failedOn } = switchVerdict(run.changed, run.failed);
  const machines = failedOn.join(', ');
  if (verdict === 'done') return { kind: 'success', title: done };
  if (verdict === 'partly') return { kind: 'warning', title: t('library.result.partly', { name, machines }) };
  return { kind: 'error', title: t('library.result.none', { name, machines }) };
}

/**
 * A value set in the repo from Per home (a plugin's, a hook's), committed at once: said in a toast with Undo, which
 * sets the value before it back. The Undo's own toast has none.
 */
export function repoValueToast(name: string, undoing: boolean, undo: () => void, t: Translate) {
  if (undoing) return { kind: 'success' as const, title: t('library.undo.done', { name }) };
  return {
    kind: 'success' as const,
    title: t('setup.repoValue.saved', { name }),
    description: t('setup.repoValue.committed'),
    action: { label: t('common.undo'), onClick: undo },
  };
}

/** An Undo's toast: back as it was, or what it couldn't put back and where, which stays until dismissed. */
export function undoToast(name: string, back: UndoResult, t: Translate): SwitchToast {
  if (back.repoError) return { kind: 'error', title: t('library.undo.repoFailed', { name, error: plainError(back.repoError, t) }) };
  const { failedOn } = switchVerdict([], back.failed);
  if (failedOn.length) return { kind: 'error', title: t('library.undo.notOn', { name, machines: failedOn.join(', ') }) };
  return { kind: 'success', title: t('library.undo.done', { name }) };
}

/**
 * Bringing machines in line, in a toast: each in line, or the ones that aren't yet named. Nothing changed anywhere,
 * it's an error that stays until dismissed.
 */
export function bringToast(chosen: string[], notInLine: string[], anyChanged: boolean, t: Translate): SwitchToast & { description: string } {
  if (!notInLine.length) {
    return {
      kind: 'success',
      title: chosen.length === 1 ? t('overview.bring.doneOne', { machine: chosen[0] ?? '' }) : t('overview.bring.doneAll', { count: chosen.length }),
      description: t('overview.bring.undoHint'),
    };
  }
  return {
    kind: anyChanged ? 'warning' : 'error',
    title: t(notInLine.length === 1 ? 'overview.bring.notOne' : 'overview.bring.notAll', { machine: notInLine[0] ?? '', machines: notInLine.join(', ') }),
    description: t('overview.bring.someFailed'),
  };
}

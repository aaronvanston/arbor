import type { ReactNode } from 'react';
import { MachinePill } from '../components/identity/Identity';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { RotateCcw } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatDateTime } from '../lib/format';
import { errorWords, plainError } from '../services/plainError';
import { tally } from '../services/setupSync';
import type { ChangeKind, SetupBackup, SyncOutcome } from '../native/types';

/**
 * The changes Arbor made on a machine and how a change went, in words: what Sync › Repo, its History and the Skills
 * dialog all show. Kept apart from the Repo section so a page that lists changes doesn't load the Library with it.
 */

type Translate = ReturnType<typeof useI18n>['t'];
type TranslateRich = ReturnType<typeof useI18n>['tRich'];

const short = (sha: string) => sha.slice(0, 7);

/** "2 files and 1 skill". */
export function countText(counts: { files: number; skills: number }, t: Translate): string {
  const files = t(counts.files === 1 ? 'setup.sync.count.files.one' : 'setup.sync.count.files.other', { count: counts.files });
  if (!counts.skills) return files;
  const skills = t(counts.skills === 1 ? 'setup.sync.count.skills.one' : 'setup.sync.count.skills.other', { count: counts.skills });
  return counts.files ? t('setup.sync.count.both', { files, skills }) : skills;
}

/** How many of the paths are files and how many skills, in words. */
export const thingsText = (paths: string[], t: Translate) => countText(tally(paths), t);

/** What a change did, in a sentence (the machine as its pill): done, refused because something changed, or partly done. */
export function outcomeText(outcome: SyncOutcome, machine: string, t: Translate, tRich: TranslateRich): { ok: boolean; text: ReactNode } {
  const changed = outcome.failed.filter((failure) => failure.reason === 'changed').map((failure) => failure.path);
  const failed = outcome.failed.filter((failure) => failure.reason === 'failed').map((failure) => failure.path);
  // A clean-up's folders deleted for good since, which Undo can't bring back.
  const deleted = outcome.failed.filter((failure) => failure.reason === 'deleted').map((failure) => failure.path);
  const pill = <MachinePill name={machine} />;
  if (changed.length) return { ok: false, text: tRich('setup.sync.outcome.changed', { machine: pill, files: changed.join(', ') }) };
  if (failed.length) return { ok: false, text: t('setup.sync.outcome.failed', { done: outcome.done.length, files: failed.join(', ') }) };
  if (deleted.length) return { ok: outcome.done.length > 0, text: tRich('setup.sync.outcome.deleted', { things: thingsText(outcome.done, t), machine: pill, files: deleted.join(', ') }) };
  return { ok: true, text: tRich('setup.sync.outcome.done', { things: thingsText(outcome.done, t), machine: pill }) };
}

/** How many files and skills a backup holds: setup sync's files and store skills, and the Skills tab's skills. */
export const backupCounts = (backup: SetupBackup) => {
  const files = backup.files.filter((file) => !file.skill).length;
  return { files, skills: backup.files.length - files + backup.skills.length };
};

/** What undoing a backup puts back, in a sentence. */
export function undoMessage(backup: SetupBackup, t: Translate): string {
  const time = formatDateTime(backup.atMs, { year: 'always' });
  if (backup.skills.length) {
    return t(backup.skills.length === 1 ? 'setup.skills.undo.confirm.one' : 'setup.skills.undo.confirm.other', { count: backup.skills.length, time });
  }
  const things = countText(backupCounts(backup), t);
  return t(backup.files.length === 1 ? 'setup.sync.undo.confirm.one' : 'setup.sync.undo.confirm.other', { things, time });
}

export const CHANGE_KIND: Record<ChangeKind, MessageKey> = {
  sync: 'setup.history.what.sync',
  skills: 'setup.history.what.skills',
  reporter: 'setup.history.what.reporter',
  keepSessions: 'setup.history.what.keepSessions',
  telemetry: 'setup.history.what.telemetry',
  mcp: 'setup.history.what.mcp',
  checkouts: 'setup.history.what.checkouts',
  plugins: 'setup.history.what.plugins',
  hooks: 'setup.history.what.hooks',
  automations: 'setup.history.what.automations',
  ssh: 'setup.history.what.ssh',
  projects: 'setup.history.what.projects',
  cleanup: 'setup.history.what.cleanup',
  uninstall: 'setup.history.what.uninstall',
  probe: 'setup.history.what.probe',
  tools: 'setup.history.what.tools',
};

/** Changes nothing can put back as they were: an uninstall, a probe update, and tools an installer changed. */
export const cannotUndo = (what: ChangeKind) => what === 'uninstall' || what === 'probe' || what === 'tools';

/**
 * The changes Arbor made on a machine, newest first, each with Undo: setup sync's files and skills, the Skills tab's
 * skills, and settings files other features changed. `limit` is how many to show.
 */
export function BackupList({ machine, backups, error, busy, undoing, onUndo, onRetry, limit = 5 }: {
  machine: string;
  backups: SetupBackup[] | null;
  error: string | null;
  busy: boolean;
  /** The backup being undone now. */
  undoing: string | null;
  onUndo: (backup: SetupBackup) => void;
  /** Lists the changes again after a failure; without it, the failure has no button beside it. */
  onRetry?: () => void;
  limit?: number;
}) {
  const { t, tRich } = useI18n();
  if (error) {
    return (
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground" title={errorWords(error)}>{t('setup.sync.history.failed', { error: plainError(error, t) })}</p>
        {onRetry ? <Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('common.tryAgain')}</Button> : null}
      </div>
    );
  }
  if (!backups?.length) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{tRich('setup.sync.history.title', { machine: <MachinePill name={machine} size="sm" /> })}</h3>
      <div className="overflow-hidden rounded-lg border border-border/60 [&>*+*]:border-t [&>*+*]:border-border/50">
        {backups.slice(0, limit).map((backup) => (
          <div key={backup.id} className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm">
            <span className="shrink-0 text-foreground">{formatDateTime(backup.atMs, { year: 'always' })}</span>
            <span
              className="min-w-0 flex-1 truncate text-muted-foreground"
              title={[...backup.files.map((file) => file.path), ...backup.skills.map((skill) => `${skill.home}/skills/${skill.name}`)].join('\n')}
            >
              {[t(CHANGE_KIND[backup.what]), countText(backupCounts(backup), t), backup.commit ? t('setup.sync.history.from', { commit: short(backup.commit) }) : null]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {cannotUndo(backup.what) ? (
              <Badge variant="outline" size="sm">{t('setup.sync.history.noUndo')}</Badge>
            ) : backup.deletedAtMs !== undefined ? (
              <Badge variant="outline" size="sm" title={formatDateTime(backup.deletedAtMs, { year: 'always' })}>{t('setup.sync.history.deleted', { when: formatAgo(backup.deletedAtMs) })}</Badge>
            ) : backup.undoneAtMs !== null ? (
              <Badge variant="outline" size="sm">{t('setup.sync.history.undone')}</Badge>
            ) : (
              <Button variant="ghost-muted" size="xs" disabled={busy} onClick={() => onUndo(backup)}>
                {undoing === backup.id ? <Spinner /> : <RotateCcw />}
                {t('setup.sync.history.undo')}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

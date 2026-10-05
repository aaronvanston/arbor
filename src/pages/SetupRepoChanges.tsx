import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { DiffStyleToggle, ViewerSkeleton } from '../components/FileChanges';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { FileCode, RotateCcw } from '../components/ui/icons';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Spinner } from '../components/ui/spinner';
import { Textarea } from '../components/ui/textarea';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { formatAgo, formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import type { RepoChange, RepoCommit, RepoEntry, RepoFileProblem, RepoStatus, SetupRepo } from '../native/types';
import { baseName, commitSetupRepo, getSetupRepoChanges, getSetupRepoLog, suggestedMessage } from '../services/repoBrowser';

const CodeChanges = lazy(() => import('../components/CodeChanges').then((module) => ({ default: module.CodeChanges })));

/** How many commits History lists. */
const LOG_LIMIT = 100;

const short = (sha: string) => sha.slice(0, 7);

/** A change's letter, as git status prints it, in git's colors. */
const LETTER: Record<Exclude<RepoStatus, 'same'>, { letter: string; className: string; key: MessageKey }> = {
  modified: { letter: 'M', className: 'text-warning-foreground', key: 'repo.status.modified' },
  added: { letter: 'A', className: 'text-success-foreground', key: 'repo.status.added' },
  deleted: { letter: 'D', className: 'text-error-foreground', key: 'repo.status.deleted' },
};

const PROBLEM: Record<RepoFileProblem, MessageKey> = {
  secret: 'repo.file.problem.secret',
  large: 'repo.file.problem.large',
  binary: 'repo.file.problem.binary',
  link: 'repo.file.problem.link',
};

/** A file added or deleted with nothing in it. */
const emptyFileChange = (change: RepoChange) => change.before !== change.after && !change.before && !change.after;

function StatusLetter({ status }: { status: RepoStatus }) {
  const { t } = useI18n();
  if (status === 'same') return null;
  const look = LETTER[status];
  return <span className={cn('w-3 shrink-0 text-center font-mono text-xs font-semibold', look.className)} title={t(look.key)}>{look.letter}</span>;
}

type Loaded<T> = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; value: T };

/** A change's words for the message it suggests: one file's name and what happened to it, or how many. */
function useSuggested(changes: readonly Pick<RepoChange, 'path' | 'status'>[]) {
  const { t } = useI18n();
  const suggested = suggestedMessage(changes);
  return suggested ? t(suggested.key, { name: suggested.name ?? '', count: suggested.count ?? 0 }) : '';
}

/**
 * Changes: every file in the folder that isn't as the last commit has it, ticked to go into the next commit, with the
 * message to commit them with; beside them, each file's changes one after another.
 */
export function ChangesMode({ repo, entries, onRepo, onOpen, onDiscard }: {
  repo: SetupRepo;
  entries: readonly RepoEntry[];
  onRepo: (repo: SetupRepo) => void;
  onOpen: (path: string) => void;
  onDiscard: (paths: string[]) => void;
}) {
  const { t } = useI18n();
  /** Files left out of the next commit; everything else goes in. */
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [loaded, setLoaded] = useState<Loaded<RepoChange[]>>({ state: 'loading' });

  // Read again whenever a file's standing or size moves, which is when its changes can have.
  const key = entries.map((entry) => `${entry.path}\u0000${entry.status}\u0000${entry.size}`).join('\n');
  useEffect(() => {
    let current = true;
    getSetupRepoChanges(repo.path)
      .then((value) => { if (current) setLoaded({ state: 'ready', value }); })
      .catch((reason: unknown) => { if (current) setLoaded({ state: 'error', error: String(reason) }); });
    return () => { current = false; };
  }, [repo.path, key]);

  const chosen = entries.filter((entry) => !left.has(entry.path));
  const suggested = useSuggested(chosen);
  const allTicked = chosen.length === entries.length;

  const commit = async () => {
    const text = message.trim() || suggested;
    if (!chosen.length || !text) return;
    setCommitting(true);
    try {
      onRepo(await commitSetupRepo(repo.path, chosen.map((entry) => entry.path), text));
      setMessage('');
      setLeft(new Set());
      toast({
        kind: 'success',
        title: t(chosen.length === 1 ? 'repo.changes.committed.one' : 'repo.changes.committed.other', { count: chosen.length }),
        description: t('repo.changes.committedNext'),
      });
    } catch (reason) {
      toast({ kind: 'error', title: t('repo.changes.commitFailed', { error: String(reason) }) });
    } finally {
      setCommitting(false);
    }
  };

  const files = loaded.state === 'ready' ? loaded.value.filter((change) => change.problem === null) : [];
  const unshown = loaded.state === 'ready' ? loaded.value.filter((change) => change.problem !== null) : [];

  return (
    <>
      <div className="col-start-1 row-start-2 flex min-h-0 flex-col border-e border-border/60">
        {entries.length ? (
          <>
            <label className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
              <Checkbox
                checked={allTicked}
                indeterminate={!allTicked && chosen.length > 0}
                onCheckedChange={(checked) => setLeft(checked ? new Set() : new Set(entries.map((entry) => entry.path)))}
                aria-label={t('repo.changes.all')}
              />
              {t(entries.length === 1 ? 'repo.changes.summary.one' : 'repo.changes.summary.other', { count: entries.length })}
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {entries.map((entry) => (
                <div key={entry.path} className="group flex min-w-0 items-center gap-2 px-3 py-1 hover:bg-accent/60">
                  <Checkbox
                    checked={!left.has(entry.path)}
                    onCheckedChange={(checked) => setLeft((current) => {
                      const next = new Set(current);
                      if (checked) next.delete(entry.path);
                      else next.add(entry.path);
                      return next;
                    })}
                    aria-label={t('repo.changes.include', { path: entry.path })}
                  />
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-start" onClick={() => onOpen(entry.path)} title={entry.path}>
                    <span className={cn('truncate text-sm', entry.status === 'deleted' ? 'text-muted-foreground line-through' : 'text-foreground')}>{baseName(entry.path)}</span>
                    <MiddleTruncate value={entry.path.slice(0, -baseName(entry.path).length).replace(/\/$/, '')} className="min-w-0 flex-1 font-mono text-2xs text-muted-foreground" />
                  </button>
                  <Button
                    variant="ghost-muted"
                    size="icon-xs"
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    aria-label={t('repo.changes.discardOne', { name: baseName(entry.path) })}
                    title={t('repo.file.discard')}
                    onClick={() => onDiscard([entry.path])}
                  >
                    <RotateCcw />
                  </Button>
                  <StatusLetter status={entry.status} />
                </div>
              ))}
            </div>
            <form className="flex flex-col gap-2 border-t border-border/60 p-2" onSubmit={(event) => { event.preventDefault(); void commit(); }}>
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={suggested || t('repo.changes.message')}
                aria-label={t('repo.changes.message')}
                rows={2}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void commit();
                  }
                }}
              />
              <Button type="submit" size="sm" disabled={!chosen.length || committing}>
                {committing ? <Spinner /> : null}
                {t(chosen.length === 1 ? 'repo.changes.commit.one' : 'repo.changes.commit.other', { count: chosen.length })}
              </Button>
              <p className="text-2xs leading-snug text-muted-foreground">{t('repo.changes.commitNote')}</p>
            </form>
          </>
        ) : (
          <p className="border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">{t('repo.changes.summary.none')}</p>
        )}
      </div>
      <section className="col-start-2 row-span-2 row-start-1 flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-11 items-center gap-3 border-b border-border/60 px-4 py-2">
          <p className="min-w-0 flex-1 text-sm text-foreground">
            {entries.length ? t(entries.length === 1 ? 'repo.changes.title.one' : 'repo.changes.title.other', { count: entries.length }) : t('repo.changes.titleNone')}
          </p>
          <DiffStyleToggle />
        </header>
        <Diffs
          loaded={loaded}
          files={files}
          unshown={unshown}
          empty={t('repo.changes.empty')}
          renderActions={(path) => (
            <span className="flex items-center gap-1">
              <Button variant="ghost-muted" size="xs" onClick={() => onOpen(path)}><FileCode />{t('repo.changes.open')}</Button>
              <Button variant="ghost-muted" size="xs" onClick={() => onDiscard([path])}><RotateCcw />{t('repo.changes.discard')}</Button>
            </span>
          )}
        />
      </section>
    </>
  );
}

/** Each file's changes one after another, with any that can't be shown named above them, and why. */
function Diffs({ loaded, files, unshown, empty, renderActions }: {
  loaded: Loaded<RepoChange[]>;
  files: RepoChange[];
  unshown: RepoChange[];
  empty: string;
  renderActions?: (path: string) => React.ReactNode;
}) {
  const { t } = useI18n();
  if (loaded.state === 'loading') return <div className="p-4"><ViewerSkeleton /></div>;
  if (loaded.state === 'error') return <p className="p-4 text-xs text-error-foreground" role="alert">{t('repo.changes.failed', { error: loaded.error })}</p>;
  if (!files.length && !unshown.length) return <p className="m-auto max-w-sm px-4 text-center text-sm text-muted-foreground">{empty}</p>;
  // An empty file added or deleted has no lines to draw, so it's named here instead of vanishing from the pane.
  const blank = files.filter(emptyFileChange);
  const drawn = files.filter((change) => !emptyFileChange(change));
  const notes = unshown.length || blank.length ? (
    <div className="flex flex-col gap-1 px-4 pb-3 text-xs text-muted-foreground">
      {unshown.map((change) => (
        <p key={change.path} className="flex min-w-0 items-center gap-2">
          <StatusLetter status={change.status} />
          <span className="font-mono text-foreground">{change.path}</span>
          {change.problem ? <span>{t(PROBLEM[change.problem])}</span> : null}
        </p>
      ))}
      {blank.map((change) => (
        <div key={change.path} className="flex min-w-0 items-center gap-2">
          <StatusLetter status={change.status} />
          <span className="font-mono text-foreground">{change.path}</span>
          <span className="me-auto">{t('repo.changes.emptyFile')}</span>
          {renderActions?.(change.path)}
        </div>
      ))}
    </div>
  ) : null;
  if (!drawn.length) return <div className="min-h-0 flex-1 overflow-y-auto pt-3">{notes}</div>;
  return (
    <div className="min-h-0 flex-1 px-3 pt-3">
      <Suspense fallback={<ViewerSkeleton />}>
        <CodeChanges files={drawn} renderActions={renderActions} header={notes} />
      </Suspense>
    </div>
  );
}

/** History: the branch's commits, newest first; beside them, everything the chosen one changed. */
export function HistoryMode({ repo }: { repo: SetupRepo }) {
  const { t } = useI18n();
  const [log, setLog] = useState<Loaded<RepoCommit[]>>({ state: 'loading' });
  const [chosen, setChosen] = useState<string | null>(null);
  const [changes, setChanges] = useState<Loaded<RepoChange[]>>({ state: 'loading' });
  const head = repo.head?.sha ?? null;
  const now = Date.now();

  useEffect(() => {
    let current = true;
    getSetupRepoLog(repo.path, LOG_LIMIT)
      .then((value) => {
        if (!current) return;
        setLog({ state: 'ready', value });
        setChosen((was) => (was && value.some((commit) => commit.sha === was) ? was : value[0]?.sha ?? null));
      })
      .catch((reason: unknown) => { if (current) setLog({ state: 'error', error: String(reason) }); });
    return () => { current = false; };
  }, [repo.path, head]);

  useEffect(() => {
    if (!chosen) return undefined;
    let current = true;
    setChanges({ state: 'loading' });
    getSetupRepoChanges(repo.path, chosen)
      .then((value) => { if (current) setChanges({ state: 'ready', value }); })
      .catch((reason: unknown) => { if (current) setChanges({ state: 'error', error: String(reason) }); });
    return () => { current = false; };
  }, [repo.path, chosen]);

  const commits = log.state === 'ready' ? log.value : [];
  const commit = commits.find((entry) => entry.sha === chosen) ?? null;
  const files = useMemo(() => (changes.state === 'ready' ? changes.value.filter((change) => change.problem === null) : []), [changes]);
  const unshown = changes.state === 'ready' ? changes.value.filter((change) => change.problem !== null) : [];

  return (
    <>
      <div className="col-start-1 row-start-2 flex min-h-0 flex-col overflow-y-auto border-e border-border/60 py-1">
        {log.state === 'loading' ? <div className="p-3"><ViewerSkeleton /></div> : null}
        {log.state === 'error' ? <p className="px-3 py-3 text-xs text-error-foreground" role="alert">{t('repo.history.failed', { error: log.error })}</p> : null}
        {log.state === 'ready' && !commits.length ? <p className="px-3 py-3 text-xs text-muted-foreground">{t('repo.history.empty')}</p> : null}
        {commits.map((entry) => (
          <button
            key={entry.sha}
            type="button"
            onClick={() => setChosen(entry.sha)}
            aria-current={entry.sha === chosen ? 'true' : undefined}
            className={cn('mx-1 flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent/60', entry.sha === chosen && 'bg-accent hover:bg-accent')}
          >
            <span className="truncate text-sm text-foreground">{entry.subject}</span>
            <span className="text-xs text-muted-foreground"><span className="font-mono">{short(entry.sha)}</span> · {formatAgo(entry.atMs, now)}</span>
          </button>
        ))}
      </div>
      <section className="col-start-2 row-span-2 row-start-1 flex min-h-0 min-w-0 flex-col">
        <header className="flex min-h-11 items-center gap-3 border-b border-border/60 px-4 py-2">
          {commit ? (
            <p className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
              <span className="truncate text-foreground">{commit.subject}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <span className="font-mono">{short(commit.sha)}</span> · {formatDateTime(commit.atMs, { year: 'always' })}
                {changes.state === 'ready' ? ` · ${t(changes.value.length === 1 ? 'repo.history.files.one' : 'repo.history.files.other', { count: changes.value.length })}` : ''}
              </span>
            </p>
          ) : <p className="flex-1 text-sm text-muted-foreground">{t('repo.history.choose')}</p>}
          <DiffStyleToggle />
        </header>
        {chosen ? <Diffs loaded={changes} files={files} unshown={unshown} empty={t('repo.history.nothing')} /> : null}
      </section>
    </>
  );
}

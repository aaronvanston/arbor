import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { DiffStyleToggle, ViewerSkeleton } from '../components/FileChanges';
import { MachinePill } from '../components/identity/Identity';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { RotateCcw } from '../components/ui/icons';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { useI18n } from '../i18n';
import { formatAgo, formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import { getSetupRepoChanges, getSetupRepoLog } from '../services/repoBrowser';
import { changeKey, nothingChangedOn, repoTimeline, type MachineChange } from '../services/repoTimeline';
import { listSetupBackups, scanned, undoSetupSync } from '../services/setupSync';
import type { RepoChange, RepoCommit, SetupBackup, SetupMachine, SetupRepo } from '../native/types';
import { Diffs, type Loaded } from './SetupRepoChanges';
import { backupCounts, CHANGE_KIND, countText, outcomeText, undoMessage } from './SetupSync';

/** How many commits History lists. */
const LOG_LIMIT = 100;
const short = (sha: string) => sha.slice(0, 7);

type Chosen = { kind: 'commit'; sha: string } | { kind: 'change'; key: string };

/**
 * History: the repo's commits and the changes Arbor made on the machines, newest first, in one list. A commit shows its
 * diff and what it changed on each machine; a machine's change shows its files and skills. Every machine change can be
 * undone from its backup, which the machine keeps.
 */
export function HistoryMode({ repo, machines, machine: asked }: {
  repo: SetupRepo;
  machines: SetupMachine[];
  /** The machine whose changes the list starts on, as a link asked; all of them when null. */
  machine: string | null;
}) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [log, setLog] = useState<Loaded<RepoCommit[]>>({ state: 'loading' });
  const [backups, setBackups] = useState<Record<string, SetupBackup[]>>({});
  const [unread, setUnread] = useState<string[]>([]);
  const [machine, setMachine] = useState<string | null>(asked);
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const [changes, setChanges] = useState<Loaded<RepoChange[]>>({ state: 'loading' });
  const [undoing, setUndoing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: ReactNode } | null>(null);
  const head = repo.head?.sha ?? null;
  const now = Date.now();
  useEffect(() => { setMachine(asked); }, [asked]);

  useEffect(() => {
    let current = true;
    getSetupRepoLog(repo.path, LOG_LIMIT)
      .then((value) => { if (current) setLog({ state: 'ready', value }); })
      .catch((reason: unknown) => { if (current) setLog({ state: 'error', error: String(reason) }); });
    return () => { current = false; };
  }, [repo.path, head]);

  const read = useMemo(() => machines.filter((entry) => scanned(entry) && entry.reachable).map((entry) => entry.machine), [machines]);
  const loadBackups = useCallback(async (names: string[]) => {
    const results = await Promise.allSettled(names.map(async (name) => [name, await listSetupBackups(name)] as const));
    setBackups((current) => {
      const next = { ...current };
      for (const result of results) if (result.status === 'fulfilled') next[result.value[0]] = result.value[1];
      return next;
    });
    setUnread((current) => [
      ...current.filter((name) => !names.includes(name)),
      ...names.filter((_, index) => results[index]?.status === 'rejected'),
    ]);
  }, []);
  const readKey = read.join('\n');
  useEffect(() => { void loadBackups(readKey ? readKey.split('\n') : []); }, [readKey, loadBackups]);

  const commits = useMemo(() => (log.state === 'ready' ? log.value : []), [log]);
  const all: MachineChange[] = useMemo(() => Object.entries(backups).flatMap(([name, list]) => list.map((backup) => ({ machine: name, backup }))), [backups]);
  const items = useMemo(() => repoTimeline(commits, all, machine), [commits, all, machine]);

  // The newest commit is chosen until something else is.
  const picked = chosen ?? (commits[0] ? { kind: 'commit' as const, sha: commits[0].sha } : null);
  const commitSha = picked?.kind === 'commit' ? picked.sha : null;
  useEffect(() => {
    if (!commitSha) return undefined;
    let current = true;
    setChanges({ state: 'loading' });
    getSetupRepoChanges(repo.path, commitSha)
      .then((value) => { if (current) setChanges({ state: 'ready', value }); })
      .catch((reason: unknown) => { if (current) setChanges({ state: 'error', error: String(reason) }); });
    return () => { current = false; };
  }, [repo.path, commitSha]);

  const undo = async (change: MachineChange) => {
    const confirmed = await askConfirmation({
      title: t('setup.history.undo.title'),
      message: undoMessage(change.backup, t),
      confirmText: t('setup.sync.history.undo'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setUndoing(changeKey(change));
    setNotice(null);
    try {
      const result = outcomeText(await undoSetupSync(change.machine, change.backup.id), change.machine, t, tRich);
      setNotice(result.ok ? { ok: true, text: tRich('setup.sync.undone', { machine: <MachinePill name={change.machine} /> }) } : result);
      await loadBackups([change.machine]);
    } catch (reason) {
      setNotice({ ok: false, text: t('setup.history.undoFailed', { error: String(reason) }) });
    } finally {
      setUndoing(null);
    }
  };

  const words = (backup: SetupBackup) => [t(CHANGE_KIND[backup.what]), countText(backupCounts(backup), t)].join(' · ');
  const commit = commitSha ? commits.find((entry) => entry.sha === commitSha) ?? null : null;
  const change = picked?.kind === 'change' ? all.find((entry) => changeKey(entry) === picked.key) ?? null : null;
  const files = changes.state === 'ready' ? changes.value.filter((entry) => entry.problem === null) : [];
  const unshown = changes.state === 'ready' ? changes.value.filter((entry) => entry.problem !== null) : [];
  const machineLabel = (value: string | null) => (value ?? t('repo.history.allMachines'));

  const undoButton = (entry: MachineChange) => (entry.backup.what === 'uninstall' || entry.backup.what === 'probe' ? (
    <Badge variant="outline" size="sm">{t('setup.sync.history.noUndo')}</Badge>
  ) : entry.backup.deletedAtMs !== undefined ? (
    <Badge variant="outline" size="sm" title={formatDateTime(entry.backup.deletedAtMs, { year: 'always' })}>{t('setup.sync.history.deleted', { when: formatAgo(entry.backup.deletedAtMs) })}</Badge>
  ) : entry.backup.undoneAtMs !== null ? (
    <Badge variant="outline" size="sm">{t('setup.sync.history.undone')}</Badge>
  ) : (
    <Button variant="ghost-muted" size="xs" disabled={undoing !== null} onClick={() => void undo(entry)}>
      {undoing === changeKey(entry) ? <Spinner /> : <RotateCcw />}
      {t('setup.sync.history.undo')}
    </Button>
  ));

  return (
    <>
      <div className="col-start-1 row-start-2 flex min-h-0 flex-col overflow-y-auto border-e border-border/60 py-1">
        <div className="px-2 pb-1">
          <Select value={machine ?? ''} onValueChange={(value) => setMachine(value ? String(value) : null)}>
            <SelectTrigger size="sm" className="w-full" aria-label={t('repo.history.machine')}>
              <SelectValue>{machine ? <MachinePill name={machine} size="sm" /> : machineLabel(null)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">{machineLabel(null)}</SelectItem>
              {read.map((name) => <SelectItem key={name} value={name}><MachinePill name={name} size="sm" /></SelectItem>)}
            </SelectPopup>
          </Select>
        </div>
        {unread.length ? <p className="px-3 py-1 text-xs text-muted-foreground">{t('repo.history.unread', { machines: unread.join(', ') })}</p> : null}
        {log.state === 'loading' ? <div className="p-3"><ViewerSkeleton /></div> : null}
        {log.state === 'error' ? <p className="px-3 py-3 text-xs text-error-foreground" role="alert">{t('repo.history.failed', { error: log.error })}</p> : null}
        {log.state === 'ready' && !items.length ? <p className="px-3 py-3 text-xs text-muted-foreground">{t('repo.history.empty')}</p> : null}
        {machine && nothingChangedOn(backups, machine) ? (
          <p className="px-3 py-1 text-xs text-muted-foreground">{tRich('repo.history.noChangesOn', { machine: <MachinePill name={machine} size="sm" /> })}</p>
        ) : null}
        {items.map((item) => {
          if (item.kind === 'commit') {
            const active = picked?.kind === 'commit' && picked.sha === item.commit.sha;
            return (
              <button
                key={item.commit.sha}
                type="button"
                onClick={() => setChosen({ kind: 'commit', sha: item.commit.sha })}
                aria-current={active ? 'true' : undefined}
                className={cn('mx-1 flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent/60', active && 'bg-accent hover:bg-accent')}
              >
                <span className="truncate text-sm text-foreground">{item.commit.subject}</span>
                <span className="text-xs text-muted-foreground"><span className="font-mono">{short(item.commit.sha)}</span> · {formatAgo(item.commit.atMs, now)}</span>
                {item.changes.length ? (
                  <span className="flex flex-wrap gap-1 pt-0.5">
                    {[...new Set(item.changes.map((entry) => entry.machine))].map((name) => <MachinePill key={name} name={name} size="sm" />)}
                  </span>
                ) : null}
              </button>
            );
          }
          const key = changeKey(item.change);
          const active = picked?.kind === 'change' && picked.key === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setChosen({ kind: 'change', key })}
              aria-current={active ? 'true' : undefined}
              className={cn('mx-1 flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-start hover:bg-accent/60', active && 'bg-accent hover:bg-accent', (item.change.backup.undoneAtMs !== null || item.change.backup.deletedAtMs !== undefined) && 'opacity-60')}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                <MachinePill name={item.change.machine} size="sm" />
                <span className="truncate">{t(CHANGE_KIND[item.change.backup.what])}</span>
                {item.change.backup.automatic ? <span className="shrink-0 text-xs text-muted-foreground" data-history-automatic>{t('autoLine.history')}</span> : null}
              </span>
              <span className="text-xs text-muted-foreground">{countText(backupCounts(item.change.backup), t)} · {formatAgo(item.change.backup.atMs, now)}</span>
            </button>
          );
        })}
      </div>
      <section className="col-start-2 row-span-2 row-start-1 flex min-h-0 min-w-0 flex-col">
        {notice ? <p className={cn('border-b border-border/60 px-4 py-2 text-sm', notice.ok ? 'text-muted-foreground' : 'text-error-foreground')} role="status">{notice.text}</p> : null}
        {change ? (
          <>
            <header className="flex min-h-11 items-center gap-3 border-b border-border/60 px-4 py-2">
              <p className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                <MachinePill name={change.machine} />
                <span className="truncate text-foreground">{words(change.backup)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(change.backup.atMs, { year: 'always' })}</span>
              </p>
              {undoButton(change)}
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm">
              {change.backup.commit ? (
                <p className="text-xs text-muted-foreground">
                  {t('repo.history.fromCommit')}{' '}
                  <button type="button" className="font-mono text-foreground underline-offset-2 hover:underline" onClick={() => {
                    const found = commits.find((entry) => entry.sha.startsWith(change.backup.commit ?? '\u0000'));
                    if (found) setChosen({ kind: 'commit', sha: found.sha });
                  }}>{short(change.backup.commit)}</button>
                </p>
              ) : null}
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {change.backup.files.map((file) => <li key={file.path} className="truncate text-foreground">{file.path}</li>)}
                {change.backup.skills.map((skill) => <li key={`${skill.home}/${skill.name}`} className="truncate text-foreground">{`${skill.home}/skills/${skill.name}`}</li>)}
              </ul>
            </div>
          </>
        ) : (
          <>
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
            {commit ? (() => {
              const applied = items.find((item) => item.kind === 'commit' && item.commit.sha === commit.sha);
              const under = applied?.kind === 'commit' ? applied.changes : [];
              return under.length ? (
                <div className="border-b border-border/60 px-4 py-2">
                  <p className="pb-1 text-xs text-muted-foreground">{t('repo.history.applied')}</p>
                  <ul className="flex flex-col">
                    {under.map((entry) => (
                      <li key={changeKey(entry)} className="flex items-center gap-3 py-1 text-sm">
                        <MachinePill name={entry.machine} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{words(entry.backup)} · {formatAgo(entry.backup.atMs, now)}</span>
                        {undoButton(entry)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null;
            })() : null}
            {commit ? <Diffs loaded={changes} files={files} unshown={unshown} empty={t('repo.history.nothing')} /> : null}
          </>
        )}
      </section>
    </>
  );
}

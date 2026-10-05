import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ProviderMark } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableEmpty } from '../components/ui/data-table';
import { Plus, RefreshCw, Search } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { useLibrary } from '../hooks/useLibrary';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import type { LibraryKind } from '../navigation';
import { directoryEntries, directorySources, getMarketplaceCatalog, type DirectoryAgent, type DirectoryEntry, type DirectorySource } from '../services/directory';
import { addPlugin, type LibrarySwitch } from '../services/libraryToggle';
import { extensionsView, isGithubRepo } from '../services/setupPlugins';
import type { MarketplaceCatalog, SetupMachine } from '../native/types';
import { LibraryMark } from './SetupLibrary';

type Read = { state: 'loading' } | { state: 'ready'; catalog: MarketplaceCatalog } | { state: 'error'; error: string };

const STANDING: Record<NonNullable<DirectoryEntry['standing']>, MessageKey> = {
  on: 'directory.standing.on',
  off: 'directory.standing.off',
  unlisted: 'directory.standing.unlisted',
  removed: 'directory.standing.removed',
};

const sourceKey = (source: Pick<DirectorySource, 'source' | 'agent'>) => `${source.agent}:${source.source.toLowerCase()}`;

/**
 * Sync › Library › Directory: what each marketplace offers, read from its GitHub repository, beside what the Library
 * has. Adding a plugin lists it on for every machine and installs it on each that answers, with Undo.
 */
export function SetupDirectory({ machines, onOpenItem }: {
  machines: SetupMachine[];
  onOpenItem: (kind: LibraryKind, key: string) => void;
}) {
  const { t } = useI18n();
  const { repoPath, sources: library, setSources, rows, loaded } = useLibrary(machines);
  const [typed, setTyped] = useState<{ source: string; agent: DirectoryAgent }[]>([]);
  const [draft, setDraft] = useState('');
  const [draftAgent, setDraftAgent] = useState<DirectoryAgent>('claude');
  const [query, setQuery] = useState('');
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});

  const sources = useMemo(() => directorySources(extensionsView(machines), library.repo, typed), [machines, library.repo, typed]);
  const wanted = sources.map(sourceKey).join('\n');
  const read = (source: DirectorySource, force = false) => {
    setReads((current) => ({ ...current, [sourceKey(source)]: { state: 'loading' } }));
    getMarketplaceCatalog(source.source, force)
      .then((catalog) => setReads((current) => ({ ...current, [sourceKey(source)]: { state: 'ready', catalog } })))
      .catch((error) => setReads((current) => ({ ...current, [sourceKey(source)]: { state: 'error', error: String(error) } })));
  };
  useEffect(() => {
    for (const source of sources) if (!reads[sourceKey(source)]) read(source);
    // Each marketplace is read once as it appears; Read again asks GitHub afresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const browse = (event: FormEvent) => {
    event.preventDefault();
    const source = draft.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!isGithubRepo(source)) {
      setProblems((current) => ({ ...current, browse: t('directory.browse.invalid') }));
      return;
    }
    setProblems((current) => ({ ...current, browse: '' }));
    setTyped((current) => [...current, { source, agent: draftAgent }]);
    setDraft('');
  };

  const undo = async (entry: DirectoryEntry, run: LibrarySwitch) => {
    setAdding(entry.id);
    try {
      const back = await run.undo();
      if (back.repo) setSources((current) => ({ ...current, repo: back.repo ?? current.repo }));
      if (back.failed.length) setProblems((current) => ({ ...current, [entry.id]: back.failed.map((item) => `${item.machine}: ${item.message}`).join(' · ') }));
      else toast({ kind: 'success', title: t('library.undo.done', { name: entry.name }) });
    } catch (error) {
      setProblems((current) => ({ ...current, [entry.id]: t('library.undo.failed', { name: entry.name, error: String(error) }) }));
    } finally {
      setAdding(null);
    }
  };

  const add = async (entry: DirectoryEntry, source: DirectorySource) => {
    if (!repoPath || adding) return;
    setAdding(entry.id);
    setProblems((current) => ({ ...current, [entry.id]: '' }));
    try {
      const run = await addPlugin(repoPath, machines, entry.id, source.source, source.agent === 'codex');
      setSources((current) => ({ ...current, repo: run.repo ?? current.repo }));
      const failed = [
        ...run.failed.map((item) => `${item.machine}: ${item.message}`),
        ...(run.needsYou.length ? [t('library.toggle.needsYou', { name: entry.name, machines: run.needsYou.join(', ') })] : []),
      ];
      if (failed.length) setProblems((current) => ({ ...current, [entry.id]: failed.join(' · ') }));
      toast({
        kind: failed.length ? 'warning' : 'success',
        title: t('directory.added', { name: entry.name }),
        description: t(run.changed.length === 1 ? 'library.toggle.machines.one' : 'library.toggle.machines.other', { count: run.changed.length }),
        action: { label: t('common.undo'), onClick: () => { void undo(entry, run); } },
      });
    } catch (error) {
      setProblems((current) => ({ ...current, [entry.id]: t('library.toggle.failed', { name: entry.name, error: String(error) }) }));
    } finally {
      setAdding(null);
    }
  };

  const search = t('directory.search');
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-xs leading-[1.5] text-muted-foreground">{t('directory.intro')}</p>
        <Input size="sm" wrapperClassName="w-64" startAddon={<Search />} value={query} placeholder={search} aria-label={search} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={browse}>
        <Input size="sm" font="mono" wrapperClassName="w-72" value={draft} placeholder={t('directory.browse.placeholder')} aria-label={t('directory.browse.label')} onChange={(event) => setDraft(event.target.value)} />
        <Select value={draftAgent} onValueChange={(value) => setDraftAgent(value === 'codex' ? 'codex' : 'claude')}>
          <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t('directory.browse.agent')}>
            <SelectValue>{t(draftAgent === 'codex' ? 'library.agent.codex' : 'library.agent.claude')}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="claude">{t('library.agent.claude')}</SelectItem>
            <SelectItem value="codex">{t('library.agent.codex')}</SelectItem>
          </SelectPopup>
        </Select>
        <Button type="submit" variant="outline" size="sm" disabled={!draft.trim()}><Plus />{t('directory.browse.button')}</Button>
        {problems.browse ? <span className="text-xs text-error-foreground">{problems.browse}</span> : null}
      </form>

      {!repoPath ? <TableEmpty>{t('library.noRepo')}</TableEmpty> : null}
      {repoPath && !loaded ? <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty> : null}

      {repoPath && loaded ? sources.map((source) => {
        const state = reads[sourceKey(source)] ?? { state: 'loading' as const };
        const entries = state.state === 'ready' ? directoryEntries(state.catalog, source.agent, rows, query) : [];
        if (query.trim() && state.state === 'ready' && !entries.length) return null;
        return (
          <SettingsSection
            key={sourceKey(source)}
            title={(
              <span className="flex items-center gap-2">
                <ProviderMark provider={source.agent} className="size-3.5" />
                {state.state === 'ready' ? state.catalog.name : source.source}
                {source.suggested ? <Badge variant="info" size="sm">{t('directory.suggested')}</Badge> : null}
              </span>
            )}
            summary={<span className="font-mono">{source.source}</span>}
            headerAction={(
              <Button variant="ghost-muted" size="icon-xs" disabled={state.state === 'loading'} onClick={() => read(source, true)} aria-label={t('directory.readAgain', { source: source.source })} title={t('directory.readAgain', { source: source.source })}>
                {state.state === 'loading' ? <Spinner className="size-3.5" /> : <RefreshCw />}
              </Button>
            )}
          >
            {state.state === 'loading' ? (
              <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('directory.reading', { source: source.source })}</span></TableEmpty>
            ) : state.state === 'error' ? (
              <p className="px-4 py-3 text-xs text-error-foreground">{t('directory.failed', { error: state.error })}</p>
            ) : !entries.length ? (
              <TableEmpty>{t('directory.empty')}</TableEmpty>
            ) : (
              <ul className="grid grid-cols-1 divide-y divide-border/50 lg:grid-cols-2 lg:divide-y-0">
                {entries.map((entry) => (
                  <li key={entry.id} className="flex flex-col gap-1 px-4 py-3" data-directory-plugin={entry.id}>
                    <div className="flex items-center gap-3">
                      <LibraryMark name={entry.name} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                          <span className="truncate">{entry.name}</span>
                          {entry.category ? <span className="shrink-0 text-xs font-normal text-muted-foreground">{entry.category}</span> : null}
                        </span>
                        {entry.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{entry.description}</span> : null}
                      </span>
                      {adding === entry.id ? <Spinner className="size-4" /> : entry.row && entry.standing && entry.standing !== 'unlisted' && entry.standing !== 'removed' ? (
                        <Button variant="ghost-muted" size="xs" onClick={() => entry.row && onOpenItem('plugins', entry.row.key)}>{t(STANDING[entry.standing])}</Button>
                      ) : (
                        <Button variant="outline" size="xs" disabled={adding !== null || !repoPath} onClick={() => void add(entry, source)} aria-label={t('directory.addAria', { name: entry.name })}>
                          <Plus />
                          {t(entry.standing ? STANDING[entry.standing] : 'directory.add')}
                        </Button>
                      )}
                    </div>
                    {problems[entry.id] ? <p className="ps-11 text-xs text-error-foreground">{problems[entry.id]}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
        );
      }) : null}

      <p className="max-w-2xl text-xs leading-[1.5] text-muted-foreground">{t('directory.openaiNote')}</p>
    </div>
  );
}

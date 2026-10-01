import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ContextMenuItem, FileTreeRowDecoration } from '@pierre/trees';
import { useConfirmation } from '../components/ConfirmationDialog';
import { FileViewToggle, ViewerSkeleton } from '../components/FileChanges';
import { MachinePill } from '../components/identity/Identity';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../components/ui/collapsible';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Copy, History, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from '../components/ui/icons';
import { Input } from '../components/ui/input';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../components/ui/menu';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '../components/ui/spinner';
import { StatusDot } from '../components/ui/status-dot';
import { toast } from '../components/ui/toast';
import { Toggle, ToggleGroup } from '../components/ui/toggle-group';
import { projectLabel, useFleetProjects } from '../components/layout/machineScope';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import type { RepoEntry, RepoFileProblem, RepoStatus, RepoText, RepoTree, SetupMachine, SetupRepo, SetupRepoSkill, SourceCheck } from '../native/types';
import {
  baseName,
  deleteSetupRepoPath,
  discardSetupRepoChanges,
  firstFile,
  homePath,
  isSkillName,
  listSetupRepoTree,
  moveSetupRepoPath,
  newPathProblem,
  projectOf,
  readSetupRepoText,
  settled,
  skillFolder,
  skillOf,
  skillTemplate,
  standings,
  uncommittedEntries,
  writeSetupRepoText,
  type Standing,
} from '../services/repoBrowser';
import type { FileView } from '../services/fileView';
import { checkSetupSkillSources, removableKind, setSetupFileRemoved, setSetupSkillRemoved, updateSetupSkill } from '../services/setupSync';
import { machineLookKey } from '../services/machineLook';
import { ChangesMode, HistoryMode } from './SetupRepoChanges';
import { ProjectInstructionsStanding } from './ProjectInstructionsCard';

// The tree and the viewers bring in large libraries, so they load the first time the browser is shown.
const RepoFileTree = lazy(() => import('../components/RepoFileTree').then((module) => ({ default: module.RepoFileTree })));
const CodeFile = lazy(() => import('../components/CodeFile').then((module) => ({ default: module.CodeFile })));
const MarkdownPreview = lazy(() => import('../components/MarkdownPreview').then((module) => ({ default: module.MarkdownPreview })));

type Mode = 'files' | 'changes' | 'history';
const isMode = (value: unknown): value is Mode => value === 'files' || value === 'changes' || value === 'history';

/** A dialog that names a new path: a new file, a new skill, a project's instructions, or a file or folder renamed. */
type Naming = { kind: 'file'; folder: string } | { kind: 'skill' } | { kind: 'instructions' } | { kind: 'rename'; path: string; folder: boolean };

const STATUS_BADGE: Record<Exclude<RepoStatus, 'same'>, { key: MessageKey; variant: 'warning' | 'success' | 'error' }> = {
  modified: { key: 'repo.status.modified', variant: 'warning' },
  added: { key: 'repo.status.added', variant: 'success' },
  deleted: { key: 'repo.status.deleted', variant: 'error' },
};

const PROBLEM: Record<RepoFileProblem, MessageKey> = {
  secret: 'repo.file.problem.secret',
  large: 'repo.file.problem.large',
  binary: 'repo.file.problem.binary',
  link: 'repo.file.problem.link',
};

/** Markdown files read rendered as well as by their source. */
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** The folder a path is in, with a slash, or nothing at the top. */
const folderOf = (path: string) => (path.includes('/') ? `${path.slice(0, path.lastIndexOf('/'))}/` : '');

/**
 * The setup repo's own files, the way a code host shows a repository: the tree on the left, the chosen file on the
 * right, highlighted, rendered or edited in place. Edits are saved to the folder and wait on Changes, with any made
 * outside Arbor, until they're committed together; History shows what each commit changed. Each file says what Arbor
 * does with it and, once committed, how each machine's copy stands, which opens that machine's review.
 */
export function RepoBrowser({ repo, machines, onRepo, onReview }: {
  repo: SetupRepo;
  machines: SetupMachine[];
  onRepo: (repo: SetupRepo) => void;
  onReview: (machine: string) => void;
}) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [tree, setTree] = useState<RepoTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('files');
  const [selected, setSelected] = useState<string | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  /** The open file has an edit that isn't saved, which choosing another file would lose. */
  const unsaved = useRef<string | null>(null);
  const [sources, setSources] = useState<SourceCheck[] | null>(null);

  const load = useCallback(async () => {
    try {
      setTree(await listSetupRepoTree(repo.path));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [repo.path]);

  // Read again with each commit, and whenever Arbor comes back to the front, since the folder is edited outside it too.
  const head = repo.head?.sha ?? null;
  useEffect(() => {
    void load();
  }, [load, head]);
  useEffect(() => {
    const again = () => void load();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [load]);

  // Where each skill came from and whether it's changed there; what GitHub said in the last 15 minutes is used again.
  const sourced = repo.skills.some((skill) => skill.source);
  useEffect(() => {
    if (!sourced) return undefined;
    let current = true;
    checkSetupSkillSources(repo.path, false).then((found) => { if (current) setSources(found); }).catch(() => undefined);
    return () => { current = false; };
  }, [repo.path, head, sourced]);

  const entries = useMemo(() => tree?.entries ?? [], [tree]);
  const byPath = useMemo(() => new Map(entries.map((entry) => [entry.path, entry])), [entries]);
  const pending = useMemo(() => uncommittedEntries(entries), [entries]);

  // The README, or the instructions, opens first; a file that's gone (renamed, deleted outside Arbor) gives way to it.
  useEffect(() => {
    if (tree && (!selected || !byPath.has(selected))) setSelected(firstFile(tree.entries));
  }, [tree, byPath, selected]);

  const open = useCallback(async (path: string) => {
    if (path === selected) return;
    if (unsaved.current) {
      const drop = await askConfirmation({
        title: t('repo.file.dropTitle', { name: baseName(unsaved.current) }),
        message: t('repo.file.dropMessage'),
        confirmText: t('repo.file.drop'),
        variant: 'danger',
      });
      if (!drop) return;
      unsaved.current = null;
    }
    setSelected(path);
  }, [selected, askConfirmation, t]);

  // A file asked for elsewhere (a skill's name on Sync › Skills) opens once the tree has it.
  const asked = useFocusRequest('repo-file');
  useEffect(() => {
    if (!asked || !tree) return;
    clearFocusRequest('repo-file');
    setMode('files');
    if (byPath.has(asked)) void open(asked);
  }, [asked, tree, byPath, open]);

  /** A folder chosen in the tree opens its skill's SKILL.md, when it's a skill; otherwise the open file stays. */
  const choose = useCallback((path: string) => {
    if (byPath.has(path)) void open(path);
    else {
      const skill = skillOf(path);
      const doc = skill && path === skillFolder(skill) ? `${path}/SKILL.md` : null;
      if (doc && byPath.has(doc)) void open(doc);
    }
  }, [byPath, open]);

  const decorate = useCallback((path: string, folder: boolean): FileTreeRowDecoration | null => {
    if (folder) {
      const skill = skillOf(path);
      const check = skill && path === skillFolder(skill) ? sources?.find((entry) => entry.name === skill) : null;
      return check?.state === 'update' ? { text: t('repo.tree.update'), title: t('setup.sources.state.update') } : null;
    }
    const entry = byPath.get(path);
    if (entry?.role === 'other') return { text: t('repo.tree.notSynced'), title: t('repo.role.other') };
    return null;
  }, [byPath, sources, t]);

  const remove = useCallback(async (path: string, folder: boolean) => {
    const inside = folder ? entries.filter((entry) => entry.path.startsWith(`${path}/`)) : [byPath.get(path)].filter(present);
    const fresh = inside.length > 0 && inside.every((entry) => entry.status === 'added');
    const confirmed = await askConfirmation({
      title: t('repo.delete.title', { name: baseName(path) }),
      message: t(fresh ? 'repo.delete.new' : folder ? 'repo.delete.folder' : 'repo.delete.tracked', { count: inside.length }),
      confirmText: t('repo.delete.button'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      setTree(await deleteSetupRepoPath(repo.path, path));
    } catch (reason) {
      toast({ kind: 'error', title: t('repo.delete.failed', { name: baseName(path), error: String(reason) }) });
    }
  }, [entries, byPath, askConfirmation, repo.path, t]);

  const discard = useCallback(async (paths: string[]) => {
    const [only] = paths;
    if (!only) return;
    const confirmed = await askConfirmation({
      title: paths.length === 1 ? t('repo.discard.title.one', { name: baseName(only) }) : t('repo.discard.title.other', { count: paths.length }),
      message: t('repo.discard.message'),
      confirmText: t('repo.discard.button'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      setTree(await discardSetupRepoChanges(repo.path, paths));
      if (selected && paths.includes(selected)) unsaved.current = null;
    } catch (reason) {
      toast({ kind: 'error', title: t('repo.discard.failed', { error: String(reason) }) });
    }
  }, [askConfirmation, repo.path, selected, t]);

  const menu = useCallback((item: ContextMenuItem, close: () => void) => (
    <TreeMenu
      item={item}
      entry={byPath.get(item.path) ?? null}
      onNewFile={() => { close(); setNaming({ kind: 'file', folder: item.kind === 'directory' ? `${item.path}/` : folderOf(item.path) }); }}
      onRename={() => { close(); setNaming({ kind: 'rename', path: item.path, folder: item.kind === 'directory' }); }}
      onDelete={() => { close(); void remove(item.path, item.kind === 'directory'); }}
      onDiscard={() => { close(); void discard([item.path]); }}
    />
  ), [byPath, remove, discard]);

  const entry = selected ? byPath.get(selected) ?? null : null;

  return (
    // Each mode draws its list under the bar on the left and its pane on the right, spanning the bar's row too.
    <div
      className="grid h-[min(78vh,880px)] min-h-[540px] grid-cols-[18rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border/70 bg-card"
      data-slot="repo-browser"
    >
      <div className="col-start-1 row-start-1 flex items-center gap-2 border-e border-b border-border/60 px-2 py-2">
        <ToggleGroup
          value={[mode]}
          aria-label={t('repo.mode.label')}
          onValueChange={(values) => {
            const [next] = values;
            if (isMode(next)) setMode(next);
          }}
        >
          <Toggle value="files">{t('repo.mode.files')}</Toggle>
          <Toggle value="changes">
            {t('repo.mode.changes')}
            {pending.length ? <Badge variant="warning" size="sm" className="ms-0.5">{pending.length}</Badge> : null}
          </Toggle>
          <Toggle value="history">{t('repo.mode.history')}</Toggle>
        </ToggleGroup>
        <NewMenu
          onFile={() => setNaming({ kind: 'file', folder: selected ? folderOf(selected) : '' })}
          onSkill={() => setNaming({ kind: 'skill' })}
          onInstructions={() => setNaming({ kind: 'instructions' })}
        />
      </div>
      {mode === 'files' ? (
        <>
          <div className="col-start-1 row-start-2 flex min-h-0 flex-col border-e border-border/60">
            {error ? <p className="px-3 py-3 text-xs text-error-foreground" role="alert">{t('repo.tree.failed', { error })}</p> : null}
            {tree ? (
              <Suspense fallback={<TreeSkeleton />}>
                <div className="min-h-0 flex-1">
                  <RepoFileTree entries={entries} selected={selected} onSelect={choose} decorate={decorate} renderMenu={menu} />
                </div>
                {tree.truncated ? <p className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">{t('repo.tree.truncated')}</p> : null}
                <RemovedEverywhere repo={repo} onRepo={onRepo} />
              </Suspense>
            ) : !error ? <TreeSkeleton /> : null}
          </div>
          <section className="col-start-2 row-span-2 row-start-1 flex min-h-0 min-w-0 flex-col">
            {entry ? (
              <FilePane
                key={entry.path}
                repo={repo}
                machines={machines}
                entry={entry}
                sources={sources}
                onTree={setTree}
                onRepo={onRepo}
                onReview={onReview}
                onUnsaved={(dirty) => { unsaved.current = dirty ? entry.path : null; }}
                onChanges={() => setMode('changes')}
                onRename={() => setNaming({ kind: 'rename', path: entry.path, folder: false })}
                onDelete={() => void remove(entry.path, false)}
                onDiscard={() => void discard([entry.path])}
              />
            ) : (
              <p className="m-auto text-sm text-muted-foreground">{tree ? t('repo.file.none') : null}</p>
            )}
          </section>
        </>
      ) : mode === 'changes' ? (
        <ChangesMode
          repo={repo}
          entries={pending}
          onRepo={onRepo}
          onOpen={(path) => { setMode('files'); void open(path); }}
          onDiscard={(paths) => void discard(paths)}
        />
      ) : (
        <HistoryMode repo={repo} />
      )}
      <NamingDialog
        naming={naming}
        repo={repo}
        machines={machines}
        entries={entries}
        onClose={() => setNaming(null)}
        onDone={(next, path) => {
          setTree(next);
          setNaming(null);
          setMode('files');
          if (path) setSelected(path);
        }}
      />
    </div>
  );
}

const present = <T,>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function TreeSkeleton() {
  return <div className="flex flex-col gap-2 px-3 py-3">{['w-1/2', 'w-2/3', 'w-3/5', 'w-1/3', 'w-2/3'].map((width) => <div key={width} className={cn('h-3 animate-skeleton rounded bg-muted', width)} />)}</div>;
}

/** New file, new skill, a project's instructions. */
function NewMenu({ onFile, onSkill, onInstructions }: { onFile: () => void; onSkill: () => void; onInstructions: () => void }) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" className="ms-auto" aria-label={t('repo.new')} title={t('repo.new')} />}>
        <Plus />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem onClick={onFile}>{t('repo.new.file')}</MenuItem>
        <MenuItem onClick={onSkill}>{t('repo.new.skill')}</MenuItem>
        <MenuItem onClick={onInstructions}>{t('repo.new.instructions')}</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** What a row's menu in the tree offers; `RepoFileTree` opens it beside the row. */
function TreeMenu({ item, entry, onNewFile, onRename, onDelete, onDiscard }: {
  item: ContextMenuItem;
  entry: RepoEntry | null;
  onNewFile: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  const { copy } = useCopyToClipboard();
  return (
    <>
      <MenuItem onClick={onNewFile}><Plus />{t('repo.new.file')}</MenuItem>
      <MenuItem onClick={onRename}><Pencil />{t('repo.file.rename')}</MenuItem>
      <MenuItem onClick={() => void copy(item.path, { label: t('repo.file.copyPath') })}><Copy />{t('repo.file.copyPath')}</MenuItem>
      {entry && entry.status !== 'same' ? <MenuItem onClick={onDiscard}><RotateCcw />{t('repo.file.discard')}</MenuItem> : null}
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={onDelete}><Trash2 />{t('repo.file.delete')}</MenuItem>
    </>
  );
}

type Loaded = { state: 'loading' } | { state: 'error'; error: string } | { state: 'ready'; text: RepoText };

/** The chosen file: what it is and where it goes, how each machine's copy stands, and the file itself. */
function FilePane({ repo, machines, entry, sources, onTree, onRepo, onReview, onUnsaved, onChanges, onRename, onDelete, onDiscard }: {
  repo: SetupRepo;
  machines: SetupMachine[];
  entry: RepoEntry;
  sources: SourceCheck[] | null;
  onTree: (tree: RepoTree) => void;
  onRepo: (repo: SetupRepo) => void;
  onReview: (machine: string) => void;
  onUnsaved: (dirty: boolean) => void;
  onChanges: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDiscard: () => void;
}) {
  const { t } = useI18n();
  const { copy } = useCopyToClipboard();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [view, setView] = useState<FileView>('source');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const deleted = entry.status === 'deleted';
  const commit = deleted ? repo.head?.sha ?? null : null;

  const read = useCallback(async () => {
    try {
      setLoaded({ state: 'ready', text: await readSetupRepoText(repo.path, entry.path, commit) });
    } catch (reason) {
      setLoaded({ state: 'error', error: String(reason) });
    }
  }, [repo.path, entry.path, commit]);

  useEffect(() => {
    void read();
  }, [read, entry.size, entry.status]);

  const text = loaded.state === 'ready' ? loaded.text : null;
  const content = text?.content ?? null;
  const dirty = editing && draft !== null && draft !== content;
  useEffect(() => onUnsaved(dirty), [dirty, onUnsaved]);

  const save = useCallback(async () => {
    if (!dirty || draft === null || saving) return;
    setSaving(true);
    setProblem(null);
    try {
      onTree(await writeSetupRepoText(repo.path, entry.path, draft, text?.sum ?? null));
      const fresh = await readSetupRepoText(repo.path, entry.path);
      setLoaded({ state: 'ready', text: fresh });
      setEditing(false);
      setDraft(null);
      toast({
        kind: 'success',
        title: t('repo.file.saved', { name: baseName(entry.path) }),
        description: t('repo.file.savedNext'),
        action: { label: t('repo.file.toChanges'), onClick: onChanges },
      });
    } catch (reason) {
      setProblem(t('repo.file.saveFailed', { name: baseName(entry.path), error: String(reason) }));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, saving, repo.path, entry.path, text?.sum, onTree, onChanges, t]);

  // ⌘S saves while editing, as in an editor.
  useEffect(() => {
    if (!editing) return undefined;
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [editing, save]);

  const badge = entry.status === 'same' ? null : STATUS_BADGE[entry.status];
  const markdown = isMarkdown(entry.path);
  const canEdit = !deleted && text !== null && text.problem === null && content !== null;
  const skill = entry.role === 'skill' ? skillOf(entry.path) : null;
  const synced = homePath(entry);
  const removable = entry.status === 'same' && (skill ? repo.skills.some((found) => found.name === skill) : synced && entry.role !== 'instructions' && removableKind(entry.role === 'hookScript' ? 'hookScript' : 'rule'));

  const removeEverywhere = async () => {
    try {
      const next = skill ? await setSetupSkillRemoved(repo.path, skill, true) : await setSetupFileRemoved(repo.path, `~/${entry.path}`, true);
      onRepo(next);
      toast({
        kind: 'success',
        title: t('setup.repo.files.removedDone', { path: skill ?? `~/${entry.path}` }),
        description: t('setup.repo.files.removedNext'),
        action: {
          label: t('common.undo'),
          onClick: () => void (skill ? setSetupSkillRemoved(repo.path, skill, false) : setSetupFileRemoved(repo.path, `~/${entry.path}`, false)).then(onRepo),
        },
      });
    } catch (reason) {
      toast({ kind: 'error', title: String(reason) });
    }
  };

  return (
    <>
      <header className="flex flex-col gap-2 border-b border-border/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <MiddleTruncate value={entry.path} className="min-w-0 font-mono text-sm text-foreground" />
          {badge ? <Badge variant={badge.variant} size="sm">{t(badge.key)}</Badge> : null}
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            {editing ? (
              <>
                <Button variant="ghost-muted" size="xs" disabled={saving} onClick={() => { setEditing(false); setDraft(null); setProblem(null); }}>{t('repo.file.cancel')}</Button>
                <Button size="xs" disabled={!dirty || saving} onClick={() => void save()} title={t('repo.file.saveTitle')}>
                  {saving ? <Spinner /> : null}
                  {t('repo.file.save')}
                </Button>
              </>
            ) : (
              <>
                {markdown && content ? <FileViewToggle value={view} onChange={setView} /> : null}
                {canEdit ? (
                  <Button variant="outline" size="xs" onClick={() => { setView('source'); setEditing(true); setDraft(content); }}>
                    <Pencil />
                    {t('repo.file.edit')}
                  </Button>
                ) : null}
                <Menu>
                  <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t('repo.file.more', { name: baseName(entry.path) })} />}>
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup align="end" className="min-w-56">
                    {!deleted ? <MenuItem onClick={onRename}><Pencil />{t('repo.file.rename')}</MenuItem> : null}
                    <MenuItem onClick={() => void copy(entry.path, { label: t('repo.file.copyPath') })}><Copy />{t('repo.file.copyPath')}</MenuItem>
                    {entry.status !== 'same' ? <MenuItem onClick={onDiscard}><RotateCcw />{t('repo.file.discard')}</MenuItem> : null}
                    {removable ? (
                      <>
                        <MenuSeparator />
                        <MenuItem variant="destructive" onClick={() => void removeEverywhere()}><History />{skill ? t('repo.skill.removeEverywhere', { name: skill }) : t('setup.repo.files.remove')}</MenuItem>
                      </>
                    ) : null}
                    {!deleted ? (
                      <>
                        <MenuSeparator />
                        <MenuItem variant="destructive" onClick={onDelete}><Trash2 />{t('repo.file.delete')}</MenuItem>
                      </>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </>
            )}
          </div>
        </div>
        <RoleLine repo={repo} machines={machines} entry={entry} sources={sources} onRepo={onRepo} onReview={onReview} />
        {problem ? <p className="text-xs text-error-foreground" role="alert">{problem}</p> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {loaded.state === 'loading' ? (
          <div className="p-4"><ViewerSkeleton /></div>
        ) : loaded.state === 'error' ? (
          <p className="p-4 text-xs text-error-foreground" role="alert">{t('repo.file.failed', { name: baseName(entry.path), error: loaded.error })}</p>
        ) : loaded.text.problem ? (
          <p className="p-4 text-sm text-muted-foreground">{t(PROBLEM[loaded.text.problem])}</p>
        ) : content === null ? (
          <p className="p-4 text-sm text-muted-foreground">{t('repo.file.missing')}</p>
        ) : (
          <div className="flex flex-col">
            {deleted ? <p className="border-b border-border/50 bg-error/6 px-4 py-2 text-xs text-error-foreground">{t('repo.file.deleted')}</p> : null}
            {!content && !editing ? <p className="px-4 py-3 text-sm text-muted-foreground">{t('repo.file.empty')}</p> : null}
            <Suspense fallback={<div className="p-4"><ViewerSkeleton /></div>}>
              {view === 'preview' && markdown && !editing ? (
                <div className="px-6 py-4"><MarkdownPreview source={content} /></div>
              ) : content || editing ? (
                <CodeFile path={entry.path} content={content} editing={editing} onDraft={setDraft} />
              ) : null}
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}

const STANDING: Record<Standing['state'], MessageKey> = {
  same: 'repo.standing.same',
  update: 'repo.standing.update',
  add: 'repo.standing.add',
  extra: 'repo.standing.extra',
  removed: 'repo.standing.removed',
  linked: 'repo.standing.linked',
  noHome: 'repo.standing.noHome',
  blocked: 'repo.standing.blocked',
  offHere: 'repo.standing.offHere',
  own: 'repo.standing.own',
  unread: 'repo.standing.unread',
};

const ROLE_KIND: Partial<Record<RepoEntry['role'], MessageKey>> = {
  rule: 'setup.repo.files.kind.rule',
  subagent: 'setup.repo.files.kind.subagent',
  command: 'setup.repo.files.kind.command',
  hookScript: 'setup.repo.files.kind.hookScript',
};

const SOURCE_LOOK: Record<SourceCheck['state'], { key: MessageKey; variant: 'success' | 'info' | 'warning' | 'error' | 'muted' }> = {
  current: { key: 'setup.sources.state.current', variant: 'success' },
  update: { key: 'setup.sources.state.update', variant: 'info' },
  changedHere: { key: 'setup.sources.state.changedHere', variant: 'warning' },
  gone: { key: 'setup.sources.state.gone', variant: 'warning' },
  unchecked: { key: 'setup.sources.state.unchecked', variant: 'muted' },
  error: { key: 'setup.sources.state.error', variant: 'error' },
};

/** Why a skill can't be synced. */
const SKILL_PROBLEM: Record<NonNullable<SetupRepoSkill['problem']>, MessageKey> = {
  link: 'setup.sync.problem.link',
  name: 'setup.sync.problem.name',
  secret: 'setup.sync.problem.secret',
  large: 'setup.sync.problem.large',
  noDoc: 'setup.sync.problem.noDoc',
};

/**
 * What Arbor does with the file, in a line: where it goes on every machine, the skill it's part of and that skill's
 * source, the project whose checkouts get it, a record Arbor keeps, or nothing. Then each machine's committed copy.
 */
function RoleLine({ repo, machines, entry, sources, onRepo, onReview }: {
  repo: SetupRepo;
  machines: SetupMachine[];
  entry: RepoEntry;
  sources: SourceCheck[] | null;
  onRepo: (repo: SetupRepo) => void;
  onReview: (machine: string) => void;
}) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [updating, setUpdating] = useState(false);
  const target = homePath(entry);
  const code = (text: string) => <code className="font-mono text-2xs text-foreground">{text}</code>;
  let line: ReactNode;
  let extra: ReactNode = null;
  if (entry.role === 'instructions') {
    line = tRich('repo.role.goes', { kind: t(entry.path.startsWith('.codex/') ? 'repo.role.codexInstructions' : 'repo.role.claudeInstructions'), path: code(target ?? '') });
  } else if (ROLE_KIND[entry.role]) {
    line = tRich('repo.role.goes', { kind: t(ROLE_KIND[entry.role] as MessageKey), path: code(target ?? '') });
  } else if (entry.role === 'skill') {
    const name = skillOf(entry.path) ?? '';
    const skill = repo.skills.find((found) => found.name === name);
    const check = sources?.find((found) => found.name === name) ?? null;
    line = tRich('repo.role.skill', { name: code(name), path: code(target ?? '') });
    if (skill?.source) {
      const from = skill.source.ref ? `${skill.source.source}@${skill.source.ref}` : skill.source.source;
      const update = async () => {
        const confirmed = await askConfirmation({
          title: t('repo.skill.updateTitle', { name }),
          message: t('setup.sources.confirm', { name, source: skill.source?.source ?? '' }),
          confirmText: t('setup.sources.update'),
        });
        if (!confirmed) return;
        setUpdating(true);
        try {
          onRepo(await updateSetupSkill(repo.path, name));
          toast({ kind: 'success', title: t('setup.sources.updated', { name, source: from }) });
        } catch (reason) {
          toast({ kind: 'error', title: t('setup.sources.updateFailed', { name, error: String(reason) }) });
        } finally {
          setUpdating(false);
        }
      };
      extra = (
        <span className="flex items-center gap-1.5">
          <span className="text-muted-foreground">{t('repo.skill.from', { source: from })}</span>
          {check ? <Badge variant={SOURCE_LOOK[check.state].variant} size="sm">{t(SOURCE_LOOK[check.state].key)}</Badge> : null}
          {check?.state === 'update' ? (
            <Button variant="outline" size="xs" disabled={updating} onClick={() => void update()} title={t('setup.sources.updateTitle', { source: skill.source.source })}>
              {updating ? <Spinner /> : null}
              {t('setup.sources.update')}
            </Button>
          ) : null}
        </span>
      );
    }
    if (skill?.problem) extra = <span className="text-warning-foreground">{t('repo.skill.blocked', { reason: t(SKILL_PROBLEM[skill.problem]) })}</span>;
  } else if (entry.role === 'projectInstructions') {
    const found = projectOf(entry.path);
    line = found?.machine
      ? tRich('repo.role.projectMachine', { project: code(found.project), machine: <MachinePill name={found.machine} size="sm" /> })
      : tRich('repo.role.projectEvery', { project: code(found?.project ?? '') });
    extra = found ? <ProjectInstructionsStanding repo={repo} machines={machines} project={found.project} /> : null;
  } else if (entry.role === 'record') {
    line = t('repo.role.record');
  } else {
    line = t('repo.role.other');
  }
  const list = entry.status === 'added' ? [] : standings(repo, machines, entry);
  return (
    <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0">{line}</span>
        {extra}
      </p>
      {entry.status === 'added' && target ? <p>{t('repo.role.notYet')}</p> : null}
      {list.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>{t('repo.standing.label')}</span>
          {list.map((standing) => (
            <button
              key={standing.machine}
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-foreground hover:bg-accent dark:bg-input/24"
              title={t('repo.standing.reviewTitle', { machine: standing.machine })}
              onClick={() => onReview(standing.machine)}
            >
              <StatusDot tone={standing.state === 'unread' ? 'muted' : settled(standing.state) ? 'success' : 'warning'} />
              <MachinePill name={standing.machine} size="sm" />
              <span className="text-muted-foreground">{t(STANDING[standing.state])}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Rules, subagents, commands and skills taken off every machine, each of which can be put back. It folds to one row under
 * the tree, and opened it scrolls in a capped height, so however many there are the tree keeps its room.
 */
function RemovedEverywhere({ repo, onRepo }: { repo: SetupRepo; onRepo: (repo: SetupRepo) => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  // A skill goes by its name, which is all its path would add to; a file by where it went on each machine.
  const removed = [...repo.removedFiles.map((path) => ({ id: path, label: path, skill: null })), ...repo.removedSkills.map((name) => ({ id: name, label: name, skill: name }))];
  if (!removed.length) return null;
  const putBack = async (id: string, skill: string | null) => {
    setBusy(id);
    try {
      onRepo(await (skill ? setSetupSkillRemoved(repo.path, skill, false) : setSetupFileRemoved(repo.path, id, false)));
    } catch (reason) {
      toast({ kind: 'error', title: String(reason) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Collapsible className="shrink-0 border-t border-border/60" data-slot="repo-removed">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground">
        {t('repo.removed.title', { count: removed.length })}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto px-3 pb-2">
          {removed.map((item) => (
            <div key={item.id} className="flex min-w-0 items-center gap-2">
              <MiddleTruncate value={item.label} className="min-w-0 flex-1 font-mono text-xs text-muted-foreground line-through" />
              <Button variant="ghost-muted" size="xs" disabled={busy !== null} onClick={() => void putBack(item.id, item.skill)}>
                {busy === item.id ? <Spinner /> : <RotateCcw />}
                {t('setup.repo.files.putBack')}
              </Button>
            </div>
          ))}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Names a new file, a new skill or a project's instructions, or a file's new path, and makes it. */
function NamingDialog({ naming, repo, machines, entries, onClose, onDone }: {
  naming: Naming | null;
  repo: SetupRepo;
  machines: SetupMachine[];
  entries: readonly RepoEntry[];
  onClose: () => void;
  onDone: (tree: RepoTree, open: string | null) => void;
}) {
  const { t } = useI18n();
  const projects = useFleetProjects();
  const [value, setValue] = useState('');
  const [project, setProject] = useState<string | null>(null);
  const [machine, setMachine] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setValue(naming?.kind === 'file' ? naming.folder : naming?.kind === 'rename' ? naming.path : '');
    setProject(projects[0]?.key ?? null);
    setMachine('');
    setFailure(null);
  }, [naming, projects]);

  const path = !naming ? '' : naming.kind === 'skill'
    ? `${skillFolder(value.trim())}/SKILL.md`
    : naming.kind === 'instructions'
      ? project ? `.agents/projects/${project.toLowerCase()}/${machine ? `machines/${machineLookKey(machine)}.md` : 'instructions.md'}` : ''
      : value.trim();
  const others = naming?.kind === 'rename' ? entries.filter((entry) => entry.path !== naming.path && !entry.path.startsWith(`${naming.path}/`)) : entries;
  const problem: MessageKey | null = !naming ? null
    : naming.kind === 'skill' && value && !isSkillName(value.trim()) ? 'repo.new.problem.skillName'
      : naming.kind === 'instructions' && !project ? 'repo.new.problem.project'
        : naming.kind === 'rename' && path === naming.path ? null
          : value || naming.kind === 'instructions' ? newPathProblem(path, others) : null;
  const ready = Boolean(naming) && problem === null && (naming?.kind === 'instructions' || value.trim().length > 0) && !(naming?.kind === 'rename' && path === naming.path);

  const make = async () => {
    if (!naming || !ready) return;
    setBusy(true);
    setFailure(null);
    try {
      if (naming.kind === 'rename') {
        onDone(await moveSetupRepoPath(repo.path, naming.path, path), naming.folder ? null : path);
      } else {
        const content = naming.kind === 'skill' ? skillTemplate(value.trim()) : '';
        onDone(await writeSetupRepoText(repo.path, path, content, null), path);
      }
    } catch (reason) {
      setFailure(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const titles: Record<Naming['kind'], [MessageKey, MessageKey]> = {
    file: ['repo.new.fileTitle', 'repo.new.fileDescription'],
    skill: ['repo.new.skillTitle', 'repo.new.skillDescription'],
    instructions: ['repo.new.instructionsTitle', 'repo.new.instructionsDescription'],
    rename: ['repo.rename.title', 'repo.rename.description'],
  };
  const [title, description] = naming ? titles[naming.kind] : titles.file;
  return (
    <Dialog open={naming !== null} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogPopup className="max-w-lg">
        <form onSubmit={(event) => { event.preventDefault(); void make(); }}>
          <DialogHeader>
            <DialogTitle>{t(title, { name: naming?.kind === 'rename' ? baseName(naming.path) : '' })}</DialogTitle>
            <DialogDescription>{t(description)}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            {naming?.kind === 'instructions' ? (
              <>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-xs text-muted-foreground">{t('repo.new.project')}</span>
                  <Select value={project} onValueChange={(next) => setProject(typeof next === 'string' ? next : null)}>
                    <SelectTrigger><SelectValue>{project ? projectLabel(project, projects) : t('repo.new.pickProject')}</SelectValue></SelectTrigger>
                    <SelectPopup>{projects.map((found) => <SelectItem key={found.key} value={found.key}>{projectLabel(found.key, projects)}</SelectItem>)}</SelectPopup>
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="text-xs text-muted-foreground">{t('repo.new.for')}</span>
                  <Select value={machine} onValueChange={(next) => setMachine(typeof next === 'string' ? next : '')}>
                    <SelectTrigger><SelectValue>{machine ? <MachinePill name={machine} size="sm" /> : t('repo.new.everyMachine')}</SelectValue></SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="">{t('repo.new.everyMachine')}</SelectItem>
                      {machines.map((found) => <SelectItem key={found.machine} value={found.machine}><MachinePill name={found.machine} size="sm" /></SelectItem>)}
                    </SelectPopup>
                  </Select>
                </label>
              </>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="text-xs text-muted-foreground">{t(naming?.kind === 'skill' ? 'repo.new.skillName' : 'repo.new.path')}</span>
                <Input font="mono" autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
              </label>
            )}
            {path && naming?.kind !== 'file' && naming?.kind !== 'rename' ? <p className="text-xs text-muted-foreground">{t('repo.new.makes', { path })}</p> : null}
            {problem ? <p className="text-xs text-error-foreground">{t(problem)}</p> : null}
            {failure ? <p className="text-xs text-error-foreground" role="alert">{failure}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={!ready || busy}>
              {busy ? <Spinner /> : null}
              {t(naming?.kind === 'rename' ? 'repo.rename.button' : 'repo.new.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import { useI18n } from '../i18n';
import { formatAgo, formatCount, formatDateTime } from '../lib/format';
import { cn } from '../lib/utils';
import type { CleanupAgent, CleanupGroup, CleanupHold, CleanupScan, SetAsideItem } from '../native/types';
import {
  archiveLine,
  CLEARABLE_KIND,
  GROUP_LABEL,
  HOLD_REASON,
  LEFTOVER_KIND,
  RESTORE_PROBLEM,
  checkCleanup,
  cleanupView,
  deleteSetAside,
  getCleanup,
  restoreSetAside,
} from '../services/cleanup';
import { readCommandError } from '../services/commandError';
import { formatBytes } from '../services/machineHealth';
import { AGENT_HOME_LABEL, ROLE_LABEL } from '../services/agentHomes';
import { INSTALL_METHOD } from './MachineAgents';
import { useConfirmation } from '../components/ConfirmationDialog';
import { HarnessMark, useHarnessName } from '../components/identity/Harness';
import { MachinePill } from '../components/identity/Identity';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { RotateCcw, Sparkles, Trash2 } from '../components/ui/icons';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Skeleton } from '../components/ui/skeleton';
import { toast } from '../components/ui/toast';
import { useCleanupActions, type CleanupActionResult } from './cleanupActions';

const size = (kb: number | null) => (kb === null ? null : formatBytes(kb * 1024));

/**
 * A machine's Clean up section: agent homes, agents, startup items whose program is gone, and the agents' logs and
 * caches, from one look at the machine that runs only when asked (Look, or Refresh). Remove moves a thing aside on the
 * machine at once, with Undo; what's set aside is listed below with Restore, and Delete for good asks first.
 */
export function MachineCleanup({ machine, pill }: { machine: string; pill: ReactNode }) {
  const { t, tRich } = useI18n();
  const { askConfirmation } = useConfirmation();
  const [scan, setScan] = useState<CleanupScan | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The path or set-aside item being changed, and a failure beside it. */
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<CleanupProblem | null>(null);

  // Another page asked for this section (a home it can't find by its path): bring it into view.
  const focus = useFocusRequest('machine-cleanup');
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus !== machine) return;
    clearFocusRequest('machine-cleanup');
    anchor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, machine]);

  // What Arbor already looked at this session shows at once; nothing runs on the machine until asked.
  useEffect(() => {
    let live = true;
    setScan(null);
    setError(null);
    setProblem(null);
    void getCleanup(machine).then((found) => { if (live) setScan(found); }, () => undefined);
    return () => { live = false; };
  }, [machine]);

  const look = async () => {
    setLooking(true);
    setError(null);
    setProblem(null);
    try {
      setScan(await checkCleanup(machine));
    } catch (reason) {
      setError(readCommandError(reason).message);
    } finally {
      setLooking(false);
    }
  };

  // Removing and uninstalling go through the same flow as on Settings › Agent homes and Sync's Other agents.
  const actions = useCleanupActions(setScan);
  const settle = (key: string, result: CleanupActionResult | null) => {
    if (result?.problem) setProblem({ key, text: result.problem.text, changed: result.problem.changed });
    setBusy(null);
  };
  const begin = (key: string) => () => {
    setBusy(key);
    setProblem(null);
  };
  const remove = async (group: CleanupGroup, path: string) => settle(path, await actions.removeItem(machine, scan, group, path, begin(path)));
  const uninstall = async (agent: CleanupAgent) => settle(agent.path, await actions.uninstall(machine, scan, agent, begin(agent.path)));

  const restore = async (item: SetAsideItem) => {
    const key = `${item.stamp}/${item.item}`;
    setBusy(key);
    setProblem(null);
    try {
      const back = await restoreSetAside(machine, item.stamp, item.item);
      setScan(back.scan);
      if (back.failed.length) setProblem({ key, text: back.failed.map((failure) => t(RESTORE_PROBLEM[failure.problem])).join(' · '), changed: false });
      else toast({ kind: 'success', title: t('machine.cleanup.restored', { name: item.path }) });
    } catch (reason) {
      setProblem({ key, text: readCommandError(reason).message, changed: false });
    } finally {
      setBusy(null);
    }
  };

  const deleteForGood = async (items: SetAsideItem[]) => {
    if (!items.length) return;
    const total = items.reduce((sum, item) => sum + (item.sizeKb ?? 0), 0);
    const one = items.length === 1 ? items[0] : undefined;
    const confirmed = await askConfirmation({
      variant: 'danger',
      title: one ? t('machine.cleanup.delete.titleOne', { name: one.path }) : t('machine.cleanup.delete.titleAll', { count: items.length }),
      // A fresh pill: one already rendered carries React's own links back into the tree, which the queue can't compare.
      message: tRich(one ? 'machine.cleanup.delete.message.one' : 'machine.cleanup.delete.message.other', { machine: <MachinePill name={machine} size="md" /> }),
      details: [{ label: t('machine.cleanup.delete.size'), value: size(total) ?? '—' }],
      confirmText: t('machine.cleanup.delete.confirm'),
    });
    if (!confirmed) return;
    const key = one ? `${one.stamp}/${one.item}` : 'all';
    setBusy(key);
    setProblem(null);
    try {
      setScan(await deleteSetAside(machine, items));
      toast({ kind: 'success', title: one ? t('machine.cleanup.deleted.one', { name: one.path }) : t('machine.cleanup.deleted.all', { count: items.length }) });
    } catch (reason) {
      setProblem({ key, text: readCommandError(reason).message, changed: false });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={anchor} className="scroll-mt-4">
    <CleanupContent
      machine={machine}
      pill={pill}
      scan={scan}
      looking={looking}
      error={error}
      busy={busy}
      problem={problem}
      onLook={() => void look()}
      onRemove={(group, path) => void remove(group, path)}
      onRestore={(item) => void restore(item)}
      onDelete={(items) => void deleteForGood(items)}
      onUninstall={(agent) => void uninstall(agent)}
    />
    </div>
  );
}

/** A failure beside the row it's about (`key`: its path, `stamp/item`, or `all`); `changed` offers Refresh. */
export type CleanupProblem = { key: string; text: string; changed: boolean };

/** The section as it stands: what the last look found, what's set aside, and what's under way. */
export function CleanupContent({ machine, pill, scan, looking, error, busy, problem, onLook, onRemove, onRestore, onDelete, onUninstall }: {
  machine: string;
  pill: ReactNode;
  scan: CleanupScan | null;
  looking: boolean;
  error: string | null;
  busy: string | null;
  problem: CleanupProblem | null;
  onLook: () => void;
  onRemove: (group: CleanupGroup, path: string) => void;
  onRestore: (item: SetAsideItem) => void;
  onDelete: (items: SetAsideItem[]) => void;
  onUninstall: (agent: CleanupAgent) => void;
}) {
  const { t, tRich } = useI18n();
  const harnessName = useHarnessName();
  const view = scan ? cleanupView(scan) : null;
  const scanned = scan?.scannedAtMs ?? null;
  const summary = view && scanned !== null
    ? [
      view.removable ? t('machine.cleanup.summary.removable', { count: view.removable, size: size(view.removableKb) ?? '' }) : t('machine.cleanup.summary.nothing'),
      view.aside.length ? t('machine.cleanup.summary.aside', { count: view.aside.length, size: size(view.asideKb) ?? '' }) : null,
    ].filter(Boolean).join(' · ')
    : undefined;

  const refresh = (
    <Button variant="ghost-muted" size="sm" onClick={() => onLook()} disabled={looking || busy !== null} aria-label={t('machine.cleanup.refreshLabel', { machine })}>
      <RefreshIcon refreshing={looking} />
      {t(scanned === null ? 'machine.cleanup.look' : 'machine.cleanup.refresh')}
    </Button>
  );

  const removeButton = (group: CleanupGroup, path: string, held: CleanupHold | null) => (
    <Button
      variant="ghost-muted"
      size="xs"
      disabled={held !== null || busy !== null || looking}
      disabledReason={held ? t(HOLD_REASON[held]) : undefined}
      onClick={() => onRemove(group, path)}
      aria-label={t('machine.cleanup.removeLabel', { name: path })}
    >
      {busy === path ? <RefreshIcon refreshing /> : <Trash2 />}
      {t('machine.cleanup.remove')}
    </Button>
  );

  const problemLine = (key: string) => (problem?.key === key ? (
    <p className="text-xs text-error-foreground" role="alert">
      {problem.text}
      {problem.changed ? (
        <Button variant="link" size="xs" className="ms-1.5 h-auto" onClick={() => onLook()}>{t('machine.cleanup.refresh')}</Button>
      ) : null}
    </p>
  ) : null);

  return (
    <SettingsSection title={t('machine.cleanup.title')} description={t('machine.cleanup.description')} summary={summary} headerAction={scan || error ? refresh : null}>
      {error ? (
        <SettingsBlock>
          <Alert variant="error" action={<Button variant="outline" size="sm" onClick={() => onLook()}>{t('common.tryAgain')}</Button>}>
            <AlertDescription><p>{t('machine.cleanup.failed', { error })}</p></AlertDescription>
          </Alert>
        </SettingsBlock>
      ) : null}
      {!view || scanned === null ? (
        looking ? (
          <SettingsBlock className="flex flex-col gap-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /><Skeleton className="h-5 w-3/5" /></SettingsBlock>
        ) : (
          <SettingsBlock className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs text-muted-foreground">{tRich('machine.cleanup.intro', { machine: pill })}</p>
            <Button variant="outline" size="sm" onClick={() => onLook()}>
              <Sparkles />
              {t('machine.cleanup.look')}
            </Button>
          </SettingsBlock>
        )
      ) : null}
      {view && scanned !== null ? (
        <>
          {view.empty ? <SettingsBlock className="text-xs text-muted-foreground">{tRich('machine.cleanup.empty', { machine: pill })}</SettingsBlock> : null}
          {scan?.partial ? <SettingsBlock className="py-2 text-xs text-warning-foreground">{t('machine.cleanup.partial')}</SettingsBlock> : null}

          {view.homes.length ? <GroupHead title={t('machine.cleanup.group.home')} kb={sumKb(view.homes)} /> : null}
          {view.homes.map((home) => (
            <Row
              key={home.path}
              path={home.path}
              mark={<HarnessMark harness={home.harness} />}
              facts={[
                t(AGENT_HOME_LABEL[home.agent]),
                size(home.sizeKb),
                home.lastSessionMs !== null
                  ? t('machine.cleanup.lastSession', { when: formatAgo(home.lastSessionMs) })
                  : home.newestMs !== null ? t('machine.cleanup.lastWritten', { when: formatAgo(home.newestMs) }) : null,
                home.sessionFiles ? t(home.sessionFiles === 1 ? 'machine.cleanup.sessions.one' : 'machine.cleanup.sessions.other', { count: formatCount(home.sessionFiles) }) : null,
              ]}
              badges={[
                home.inside ? <Badge key="inside" variant="outline" size="sm">{t('machine.cleanup.inside', { app: home.inside })}</Badge> : null,
                home.installed ? null : <Badge key="installed" variant="muted" size="sm">{t('machine.cleanup.notInstalled')}</Badge>,
                <Badge key="role" variant="muted" size="sm">{t(ROLE_LABEL[home.role])}</Badge>,
              ]}
              action={removeButton('home', home.path, home.held)}
              standing={home.archive ? (({ key, variables, ok }) => ({ text: t(key, variables), ok }))(archiveLine(home.archive)) : null}
              note={home.ownSessions
                ? home.ownSessionsArchived
                  ? t('machine.cleanup.ownSessionsArchived', { agent: harnessName(home.harness), path: home.ownSessions })
                  : t('machine.cleanup.ownSessions', { agent: harnessName(home.harness) })
                : null}
              problem={problemLine(home.path)}
            />
          ))}

          {scan?.agents.length ? <GroupHead title={t('machine.cleanup.group.agents')} /> : null}
          {scan?.agents.map((agent) => (
            <AgentRow
              key={agent.path}
              agent={agent}
              busy={busy === agent.path}
              disabled={busy !== null || looking}
              onUninstall={() => onUninstall(agent)}
              problem={problemLine(agent.path)}
            />
          ))}

          {view.leftovers.length ? <GroupHead title={t('machine.cleanup.group.leftover')} kb={sumKb(view.leftovers)} /> : null}
          {view.leftovers.map((leftover) => (
            <Row
              key={leftover.path}
              path={leftover.path}
              title={leftover.name}
              facts={[t(LEFTOVER_KIND[leftover.kind]), t('machine.cleanup.leftover.missing', { program: leftover.program })]}
              action={removeButton('leftover', leftover.path, leftover.held)}
              problem={problemLine(leftover.path)}
            />
          ))}

          {view.caches.length ? <GroupHead title={t('machine.cleanup.group.cache')} kb={sumKb(view.caches)} /> : null}
          {view.caches.map((cache) => (
            <Row
              key={cache.path}
              path={cache.path}
              mark={<HarnessMark harness={cache.harness} />}
              facts={[t(CLEARABLE_KIND[cache.kind]), size(cache.sizeKb), cache.newestMs !== null ? t('machine.cleanup.lastWritten', { when: formatAgo(cache.newestMs) }) : null]}
              action={removeButton('cache', cache.path, cache.held)}
              problem={problemLine(cache.path)}
            />
          ))}
        </>
      ) : null}

      {view?.aside.length ? (
        <>
          <GroupHead
            title={t('machine.cleanup.group.aside')}
            kb={view.asideKb}
            action={(
              <Button variant="ghost-muted" size="xs" disabled={busy !== null} onClick={() => onDelete(view.aside)} aria-label={t('machine.cleanup.deleteAllLabel', { machine })}>
                {busy === 'all' ? <RefreshIcon refreshing /> : <Trash2 />}
                {t('machine.cleanup.deleteAll')}
              </Button>
            )}
          />
          {problemLine('all')}
          {view.aside.map((item) => {
            const key = `${item.stamp}/${item.item}`;
            return (
              <Row
                key={key}
                path={item.path}
                facts={[
                  t(GROUP_LABEL[item.group]),
                  size(item.sizeKb),
                  t('machine.cleanup.setAsideAt', { when: formatDateTime(item.atMs) }),
                  item.volume ? t('machine.cleanup.onDrive', { drive: item.volume }) : null,
                ]}
                action={(
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost-muted"
                      size="xs"
                      disabled={item.taken || busy !== null}
                      disabledReason={item.taken ? t('machine.cleanup.restore.taken') : undefined}
                      onClick={() => onRestore(item)}
                      aria-label={t('machine.cleanup.restoreLabel', { name: item.path })}
                    >
                      {busy === key ? <RefreshIcon refreshing /> : <RotateCcw />}
                      {t('machine.cleanup.restore')}
                    </Button>
                    <Button
                      variant="ghost-muted"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => onDelete([item])}
                      aria-label={t('machine.cleanup.deleteLabel', { name: item.path })}
                    >
                      <Trash2 />
                      {t('machine.cleanup.deleteOne')}
                    </Button>
                  </div>
                )}
                problem={problemLine(key)}
              />
            );
          })}
        </>
      ) : null}
    </SettingsSection>
  );
}

const sumKb = (items: readonly { sizeKb: number | null }[]) => items.reduce((sum, item) => sum + (item.sizeKb ?? 0), 0);

function GroupHead({ title, kb, action }: { title: string; kb?: number; action?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 bg-muted/30 px-4 py-1.5 dark:bg-input/12">
      <h3 className="text-xs font-medium text-muted-foreground">
        {title}
        {kb ? <span className="ms-2 font-normal tabular-nums">{size(kb)}</span> : null}
      </h3>
      {action}
    </div>
  );
}

function Row({ path, title, mark, facts, badges, action, standing, note, problem }: {
  path: string;
  title?: string;
  mark?: ReactNode;
  facts: (string | null)[];
  badges?: ReactNode[];
  action: ReactNode;
  /** A home's sessions as the archive has them. */
  standing?: { text: string; ok: boolean } | null;
  /** A line about what removing it takes along. */
  note?: string | null;
  problem?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5" data-cleanup-path={path}>
      {mark ? <span className="mt-0.5 flex shrink-0">{mark}</span> : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {title ? <span className="truncate text-sm text-foreground">{title}</span> : <MiddleTruncate value={path} className="font-mono text-sm text-foreground" />}
          {badges}
        </div>
        <p className={cn('truncate text-xs text-muted-foreground', title && 'font-mono')} title={title ? path : undefined}>
          {[title ? path : null, ...facts].filter(Boolean).join(' · ')}
        </p>
        {standing ? <p className={cn('text-xs', standing.ok ? 'text-success-foreground' : 'text-warning-foreground')} data-archive-standing="">{standing.text}</p> : null}
        {note ? <p className="text-xs text-warning-foreground">{note}</p> : null}
        {problem}
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/** An agent's command, with its version and how it was installed. Removing agents comes later, so it has no button. */
function AgentRow({ agent, busy, disabled, onUninstall, problem }: { agent: CleanupAgent; busy: boolean; disabled: boolean; onUninstall: () => void; problem: ReactNode }) {
  const { t } = useI18n();
  const harnessName = useHarnessName();
  const method = INSTALL_METHOD[agent.method];
  const names = { agent: harnessName(agent.harness), path: agent.path };
  return (
    <div className="flex items-start gap-3 px-4 py-2.5" data-cleanup-agent={agent.path}>
      <span className="mt-0.5 flex shrink-0"><HarnessMark harness={agent.harness} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-sm text-foreground">{harnessName(agent.harness)}</span>
          {agent.version ? <span className="text-xs tabular-nums text-muted-foreground">{agent.version}</span> : null}
          {agent.first ? null : <Badge variant="muted" size="sm">{t('machine.cleanup.agent.shadowed')}</Badge>}
        </div>
        <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <MiddleTruncate value={agent.path} className="font-mono" />
          <span className="shrink-0">· {method ? t(method) : t('machine.cleanup.agent.unknownMethod')}</span>
        </p>
        {agent.removal === 'unknown' ? <p className="text-xs text-muted-foreground">{t('machine.cleanup.agent.unknownHow')}</p> : null}
        {problem}
      </div>
      {agent.removal === 'unknown' ? null : (
        <Button
          variant="ghost-muted"
          size="xs"
          disabled={disabled}
          onClick={onUninstall}
          aria-label={t(agent.removal === 'native' ? 'machine.cleanup.agent.removeLabel' : 'machine.cleanup.agent.uninstallLabel', names)}
        >
          {busy ? <RefreshIcon refreshing /> : <Trash2 />}
          {t(agent.removal === 'native' ? 'machine.cleanup.agent.remove' : 'machine.cleanup.agent.uninstall')}
        </Button>
      )}
    </div>
  );
}

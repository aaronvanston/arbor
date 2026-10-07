import { useEffect, useMemo, useState } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableEmpty } from '../components/ui/data-table';
import { ChevronRight, MoreHorizontal } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { StatusDot } from '../components/ui/status-dot';
import { toast } from '../components/ui/toast';
import { useLibrary } from '../hooks/useLibrary';
import { useI18n } from '../i18n';
import { formatAgo, formatCount } from '../lib/format';
import type { LibraryKind } from '../navigation';
import { libraryCounts } from '../services/library';
import { bringable, bringInLine, linePlans, type LinePlan } from '../services/libraryToggle';
import { plainError } from '../services/plainError';
import { bringToast, switchFailureText } from '../services/switchReport';
import { getSetupRepoLog } from '../services/repoBrowser';
import { applies, CHANGE_WORDS, standingOf } from '../services/syncStanding';
import { autoLineWords, isPaused, setAutoLinePaused, useAutoLine } from '../services/setupAutoline';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../components/ui/menu';
import type { BehindItem, RepoCommit, SetupMachine } from '../native/types';
import { KIND_LABEL } from './SetupLibrary';

/** How many of the repo's commits Overview lists. */
const RECENT = 5;
/** How many names a machine's line lists before saying how many more. */
const NAMED = 4;

/** Plans as the confirmation lists them: each machine's kinds, with the names that change. */
function planDetails(plans: LinePlan[], t: ReturnType<typeof useI18n>['t']) {
  return plans.flatMap((plan) => [...new Set(plan.rows.map((row) => row.kind))].map((kind) => ({
    label: plans.length > 1 ? `${plan.machine} · ${t(KIND_LABEL[kind])}` : t(KIND_LABEL[kind]),
    value: plan.rows.filter((row) => row.kind === kind).map((row) => row.name).join(', '),
  })));
}

/**
 * The top of Sync's Overview: where the machines stand against the repo, each one behind with what's behind and a way
 * to bring it in line, and what the repo changed lately.
 */
export function SetupOverviewHead({ machines, onOpenItem, onOpenProjects, onOpenRepo, onOpenHistory }: {
  machines: SetupMachine[];
  onOpenItem: (kind: LibraryKind, key: string) => void;
  /** Sync › Projects, where a project behind on a machine is put right. */
  onOpenProjects: () => void;
  onOpenRepo: () => void;
  /** The Repo's History, with every machine's changes. */
  onOpenHistory: () => void;
}) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const { repoPath, sources, loaded, loadError, rows, standing, kindErrors, readAgain } = useLibrary(machines);
  const autoLine = useAutoLine();
  /** Pauses or resumes a machine's runs by themselves: its own value, which Undo puts back. */
  const pause = (machine: string, paused: boolean) => {
    setAutoLinePaused(machine, paused)
      .then(() => toast({
        kind: 'success',
        title: t(paused ? 'autoLine.paused.done' : 'autoLine.resumed.done', { machine }),
        action: { label: t('common.undo'), onClick: () => { void setAutoLinePaused(machine, !paused).catch(() => undefined); } },
      }))
      .catch((error: unknown) => toast({ kind: 'error', title: t('autoLine.pause.failed', { machine }), description: String(error) }));
  };
  const [running, setRunning] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [log, setLog] = useState<RepoCommit[] | null>(null);
  const head = sources.repo?.head?.sha ?? null;

  useEffect(() => {
    if (!repoPath) return undefined;
    let current = true;
    getSetupRepoLog(repoPath, RECENT).then((commits) => { if (current) setLog(commits); }, () => { if (current) setLog([]); });
    return () => { current = false; };
  }, [repoPath, head]);

  const plans = useMemo(() => linePlans(rows, machines), [rows, machines]);
  // How many machines are in step, and what's behind, is Sync's standing, worked out once in Rust.
  const behindKeys = new Set(standing?.machines.flatMap((machine) => machine.behind.map((item) => item.key)) ?? []);
  const counts = libraryCounts(rows);
  const kindError = Object.values(kindErrors)[0] ?? null;
  const items = Object.values(counts).reduce((sum, count) => sum + count, 0);

  const bring = async (chosen: LinePlan[]) => {
    if (!repoPath || running || !chosen.length) return;
    const confirmed = await askConfirmation({
      title: chosen.length === 1 ? t('overview.bring.titleOne', { machine: chosen[0]?.machine ?? '' }) : t('overview.bring.titleAll', { count: chosen.length }),
      message: t('overview.bring.message'),
      details: planDetails(chosen, t),
      confirmText: t('overview.bring.confirm'),
    });
    if (!confirmed) return;
    const failures: Record<string, string[]> = {};
    // Machines that changed nothing they were asked to, and ones that changed some of it.
    const notInLine: string[] = [];
    let anyChanged = false;
    for (const plan of chosen) {
      setRunning(plan.machine);
      try {
        const done = await bringInLine(repoPath, sources, machines, plan);
        anyChanged ||= done.changed;
        failures[plan.machine] = [
          ...done.failed.map((entry) => switchFailureText(entry, t)),
          ...(done.needsYou ? [t('overview.bring.needsYou')] : []),
          ...(done.heldHooks ? [t('overview.bring.heldHooks')] : []),
        ];
        if (done.failed.length || done.needsYou) notInLine.push(plan.machine);
      } catch (error) {
        failures[plan.machine] = [plainError(error, t)];
        notInLine.push(plan.machine);
      }
    }
    setRunning(null);
    setProblems((current) => ({ ...current, ...failures }));
    readAgain();
    toast(bringToast(chosen.map((plan) => plan.machine), notInLine, anyChanged, t));
  };

  if (!repoPath) {
    return (
      <SettingsSection title={t('overview.machines.title')}>
        <TableEmpty action={<Button variant="outline" size="sm" onClick={onOpenRepo}>{t('library.noRepo.open')}</Button>}>{t('library.noRepo')}</TableEmpty>
      </SettingsSection>
    );
  }

  /**
   * What a machine is behind on, as badges: a Library row opens its page, a project Sync › Projects. One edited on the
   * machine says so, and its page is where it's decided; nothing here brings it in line.
   */
  const badge = (item: BehindItem) => {
    const row = rows.find((entry) => entry.key === item.key && bringable(entry));
    const open = row ? () => onOpenItem(row.kind, row.key) : item.kind === 'project' ? onOpenProjects : null;
    const held = !applies(item.change);
    // Not knowing who moved is said once per machine, not on every badge: after an update every item starts that way.
    const word = held ? CHANGE_WORDS[item.change] : null;
    const label = word ? <>{item.name}<span className="text-muted-foreground">· {t(word)}</span></> : item.name;
    const variant = held ? 'info' : 'outline';
    return open
      ? <Badge key={item.key} variant={variant} data-change={item.change} render={<button type="button" onClick={open} />}>{label}</Badge>
      : <Badge key={item.key} variant={variant} data-change={item.change}>{label}</Badge>;
  };
  // A repo Arbor can't read can't be compared with, so nothing is counted against it, rather than every machine
  // looking in step.
  const unreadable = loaded && loadError !== null;
  const pending = unreadable ? '—' : '…';
  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={4}>
        <StatBlock
          label={t('overview.stat.inStep')}
          value={standing ? t('overview.stat.inStepValue', { count: standing.inStep, of: standing.read }) : pending}
          tone={standing && standing.inStep < standing.read ? 'warning' : 'default'}
          hint={unreadable ? t('overview.repoUnreadable.hint') : undefined}
        />
        <StatBlock label={t('overview.stat.items')} value={unreadable ? '—' : loaded ? formatCount(items) : '…'} />
        <StatBlock label={t('overview.stat.behind')} value={standing ? formatCount(behindKeys.size) : pending} tone={behindKeys.size ? 'warning' : 'default'} />
        <StatBlock label={t('overview.stat.lastChange')} value={sources.repo?.head ? formatAgo(sources.repo.head.atMs) : '—'} hint={sources.repo?.head?.subject} />
      </StatsGrid>

      <SettingsSection
        title={t('overview.machines.title')}
        description={t('overview.machines.about')}
        headerAction={plans.length > 1 ? (
          <Button variant="outline" size="sm" disabled={running !== null} onClick={() => void bring(plans)}>{t('overview.bring.all')}</Button>
        ) : undefined}
      >
        {kindError ? <p className="px-4 pt-3 text-xs text-error-foreground" role="alert">{t('overview.kindFailed', { error: kindError })}</p> : null}
        {unreadable ? (
          <TableEmpty action={<Button variant="outline" size="sm" onClick={onOpenRepo}>{t('library.noRepo.open')}</Button>}>
            <span className="text-error-foreground" role="alert">{t('setup.repo.failed', { error: loadError })}</span>
          </TableEmpty>
        ) : !loaded || (!standing && repoPath) ? (
          <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty>
        ) : (
          <ul className="divide-y divide-border/50">
            {machines.map((machine) => {
              const plan = plans.find((entry) => entry.machine === machine.machine) ?? null;
              const found = standingOf(standing, machine.machine);
              const state = found?.state ?? 'notScanned';
              // What waits on a decision first, so it isn't lost among the rest.
              const behind = [...(found?.behind ?? [])].sort((a, b) => Number(applies(a.change)) - Number(applies(b.change)));
              const decide = found?.counts.decide ?? 0;
              const unknown = behind.some((item) => item.change === 'unknown');
              const tone = state === 'behind' ? 'warning' : state === 'inStep' ? 'success' : 'muted';
              return (
                <li key={machine.machine} className="flex flex-col gap-1.5 px-4 py-3" data-overview-machine={machine.machine}>
                  <div className="flex items-center gap-4">
                    <StatusDot tone={tone} className="size-1.5" />
                    <span className="w-40 shrink-0"><MachinePill name={machine.machine} /></span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {state === 'notScanned' ? <span className="text-muted-foreground">{t('overview.machine.unread')}</span>
                        : state === 'unreachable' ? <span className="text-muted-foreground">{t('overview.machine.unreachable')}</span>
                          : state === 'inStep' ? <span className="text-muted-foreground">{t('overview.machine.inStep')}</span>
                            : (
                              <>
                                <span className="text-foreground">{t('overview.machine.behind', { count: behind.length })}</span>
                                {behind.slice(0, NAMED).map(badge)}
                                {behind.length > NAMED ? <span className="text-xs text-muted-foreground">{t('overview.machine.more', { count: behind.length - NAMED })}</span> : null}
                                {unknown ? <span className="basis-full text-xs text-muted-foreground">{t('overview.machine.unknown')}</span> : null}
                                {decide ? <span className="text-xs text-info-foreground">{t(decide === 1 ? 'overview.machine.decide.one' : 'overview.machine.decide.other', { count: decide })}</span> : null}
                              </>
                            )}
                    </span>
                    {autoLine?.enabled ? (
                      <Menu>
                        <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={t('autoLine.menu', { machine: machine.machine })} title={t('autoLine.menu', { machine: machine.machine })} />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => pause(machine.machine, !isPaused(autoLine, machine.machine))}>
                            {t(isPaused(autoLine, machine.machine) ? 'autoLine.resume' : 'autoLine.pause')}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    ) : null}
                    {running === machine.machine ? <Spinner className="size-4" /> : plan ? (
                      <Button variant="outline" size="sm" disabled={running !== null} onClick={() => void bring([plan])}>{t('overview.bring.one')}</Button>
                    ) : null}
                  </div>
                  {autoLine?.enabled && state !== 'notScanned' ? (
                    <p className="ps-48 text-xs text-muted-foreground" data-autoline-machine={machine.machine}>{autoLineWords(autoLine, machine.machine, (ms) => formatAgo(ms), t)}</p>
                  ) : null}
                  {(problems[machine.machine] ?? []).map((text) => <p key={text} className="ps-48 text-xs text-error-foreground">{text}</p>)}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('overview.recent.title')}
        headerAction={<Button variant="ghost" size="sm" onClick={onOpenHistory}>{t('overview.recent.all')}<ChevronRight /></Button>}
      >
        {log === null ? (
          <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty>
        ) : !log.length ? (
          <TableEmpty>{t('overview.recent.none')}</TableEmpty>
        ) : (
          <ul className="divide-y divide-border/50">
            {log.map((commit) => (
              <li key={commit.sha} className="flex items-center gap-4 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{formatAgo(commit.atMs)}</span>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}

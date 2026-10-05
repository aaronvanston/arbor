import { useEffect, useMemo, useState } from 'react';
import { useConfirmation } from '../components/ConfirmationDialog';
import { MachinePill } from '../components/identity/Identity';
import { SettingsSection } from '../components/layout/settings';
import { StatBlock, StatsGrid } from '../components/layout/stats';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { TableEmpty } from '../components/ui/data-table';
import { ChevronRight } from '../components/ui/icons';
import { Spinner } from '../components/ui/spinner';
import { StatusDot } from '../components/ui/status-dot';
import { toast } from '../components/ui/toast';
import { useLibrary } from '../hooks/useLibrary';
import { useI18n } from '../i18n';
import { formatAgo, formatCount } from '../lib/format';
import type { LibraryKind } from '../navigation';
import { libraryCounts, type LibraryRow } from '../services/library';
import { bringInLine, linePlans, type LinePlan } from '../services/libraryToggle';
import { getSetupRepoLog } from '../services/repoBrowser';
import { scanned } from '../services/setupSync';
import type { RepoCommit, SetupMachine } from '../native/types';
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
export function SetupOverviewHead({ machines, onOpenItem, onOpenRepo }: {
  machines: SetupMachine[];
  onOpenItem: (kind: LibraryKind, key: string) => void;
  onOpenRepo: () => void;
}) {
  const { t } = useI18n();
  const { askConfirmation } = useConfirmation();
  const { repoPath, sources, loaded, rows, readAgain } = useLibrary(machines);
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
  const read = machines.filter(scanned);
  const inStep = read.filter((machine) => machine.reachable && !plans.some((plan) => plan.machine === machine.machine));
  const behindRows = rows.filter((row) => row.behind.length > 0 && row.toggle && row.state !== 'unlisted');
  const counts = libraryCounts(rows);
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
    for (const plan of chosen) {
      setRunning(plan.machine);
      try {
        const done = await bringInLine(repoPath, sources, machines, plan);
        failures[plan.machine] = [
          ...done.failed.map((entry) => entry.message),
          ...(done.needsYou ? [t('overview.bring.needsYou')] : []),
        ];
      } catch (error) {
        failures[plan.machine] = [String(error)];
      }
    }
    setRunning(null);
    setProblems((current) => ({ ...current, ...failures }));
    readAgain();
    const failed = Object.values(failures).some((texts) => texts.length);
    toast({
      kind: failed ? 'warning' : 'success',
      title: chosen.length === 1 ? t('overview.bring.doneOne', { machine: chosen[0]?.machine ?? '' }) : t('overview.bring.doneAll', { count: chosen.length }),
      description: t(failed ? 'overview.bring.someFailed' : 'overview.bring.undoHint'),
    });
  };

  if (!repoPath) {
    return (
      <SettingsSection title={t('overview.machines.title')}>
        <TableEmpty action={<Button variant="outline" size="sm" onClick={onOpenRepo}>{t('library.noRepo.open')}</Button>}>{t('library.noRepo')}</TableEmpty>
      </SettingsSection>
    );
  }

  const behindNames = (machine: string) => rows.filter((row) => row.behind.includes(machine) && row.toggle && row.state !== 'unlisted');
  return (
    <div className="flex flex-col gap-6">
      <StatsGrid columns={4}>
        <StatBlock
          label={t('overview.stat.inStep')}
          value={loaded ? t('overview.stat.inStepValue', { count: inStep.length, of: read.length }) : '…'}
          tone={loaded && inStep.length < read.length ? 'warning' : 'default'}
        />
        <StatBlock label={t('overview.stat.items')} value={loaded ? formatCount(items) : '…'} />
        <StatBlock label={t('overview.stat.behind')} value={loaded ? formatCount(behindRows.length) : '…'} tone={behindRows.length ? 'warning' : 'default'} />
        <StatBlock label={t('overview.stat.lastChange')} value={sources.repo?.head ? formatAgo(sources.repo.head.atMs) : '—'} hint={sources.repo?.head?.subject} />
      </StatsGrid>

      <SettingsSection
        title={t('overview.machines.title')}
        description={t('overview.machines.about')}
        headerAction={plans.length > 1 ? (
          <Button variant="outline" size="sm" disabled={running !== null} onClick={() => void bring(plans)}>{t('overview.bring.all')}</Button>
        ) : undefined}
      >
        {!loaded ? (
          <TableEmpty><span className="inline-flex items-center gap-2"><Spinner />{t('library.loading')}</span></TableEmpty>
        ) : (
          <ul className="divide-y divide-border/50">
            {machines.map((machine) => {
              const plan = plans.find((entry) => entry.machine === machine.machine) ?? null;
              const behind = behindNames(machine.machine);
              const tone = !scanned(machine) || !machine.reachable ? 'muted' : plan ? 'warning' : 'success';
              return (
                <li key={machine.machine} className="flex flex-col gap-1.5 px-4 py-3" data-overview-machine={machine.machine}>
                  <div className="flex items-center gap-4">
                    <StatusDot tone={tone} className="size-1.5" />
                    <span className="w-40 shrink-0"><MachinePill name={machine.machine} /></span>
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      {!scanned(machine) ? <span className="text-muted-foreground">{t('overview.machine.unread')}</span>
                        : !machine.reachable ? <span className="text-muted-foreground">{t('overview.machine.unreachable')}</span>
                          : !behind.length ? <span className="text-muted-foreground">{t('overview.machine.inStep')}</span>
                            : (
                              <>
                                <span className="text-foreground">{t('overview.machine.behind', { count: behind.length })}</span>
                                {behind.slice(0, NAMED).map((row: LibraryRow) => (
                                  <Badge key={row.key} variant="outline" render={<button type="button" onClick={() => onOpenItem(row.kind, row.key)} />}>{row.name}</Badge>
                                ))}
                                {behind.length > NAMED ? <span className="text-xs text-muted-foreground">{t('overview.machine.more', { count: behind.length - NAMED })}</span> : null}
                              </>
                            )}
                    </span>
                    {running === machine.machine ? <Spinner className="size-4" /> : plan ? (
                      <Button variant="outline" size="sm" disabled={running !== null} onClick={() => void bring([plan])}>{t('overview.bring.one')}</Button>
                    ) : null}
                  </div>
                  {(problems[machine.machine] ?? []).map((text) => <p key={text} className="ps-48 text-xs text-error-foreground">{text}</p>)}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('overview.recent.title')}
        headerAction={<Button variant="ghost" size="sm" onClick={onOpenRepo}>{t('overview.recent.all')}<ChevronRight /></Button>}
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

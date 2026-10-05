import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderGit2 } from '../components/ui/icons';
import { SectionAbout } from '../components/layout/settings';
import { projectLabel, useFleetProjects } from '../components/layout/machineScope';
import { MachinePill } from '../components/identity/Identity';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../components/ui/menu';
import { MiddleTruncate } from '../components/ui/middle-truncate';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/resources';
import { cn } from '../lib/utils';
import { projectSettingsKey } from '../services/machineSettings';
import { checkoutsStanding, projectCheckouts, projectValueAt, readyByMachine, type Blocked, type CheckoutChange, type ProjectCheckout } from '../services/projectCheckouts';
import { getProjects, scanProjects } from '../services/setupProjects';
import { setSyncProject, useSyncScope } from '../services/syncScope';
import type { MachineProjects, RepoProjectValue } from '../native/types';
import { NameCell } from './SetupNameCell';

type Value = 'on' | 'off' | 'none';

/** One thing a project can turn on or off: a plugin or a skill, with its projects' values from the setup repo. */
export type ProjectRow = { id: string; name: string; note: string | null; projects: Record<string, RepoProjectValue> };

export const BLOCKED: Record<Blocked, MessageKey> = {
  notInstalled: 'projectCheckouts.blocked.notInstalled',
  policy: 'projectCheckouts.blocked.policy',
  ignored: 'projectCheckouts.blocked.ignored',
  seen: 'projectCheckouts.blocked.seen',
  denied: 'projectCheckouts.blocked.denied',
  toggled: 'projectCheckouts.blocked.toggled',
  noDefinition: 'projectCheckouts.blocked.noDefinition',
  own: 'projectCheckouts.blocked.own',
};

/**
 * "In a project" on Sync's Plugins and Skills: a project's own value for each thing the setup repo has, on every machine
 * or on one, and each of the project's checkouts brought in step in Claude Code's local scope. The kind says how.
 * Sync's scope sentence picks the project, and a machine narrows it to that machine's checkouts; at All projects the
 * card lists the projects that have values of their own.
 */
export function ProjectCheckoutsCard({ title, description, column, reviewDescription, rows, changesFor, save, apply }: {
  title: string;
  description: string;
  column: string;
  reviewDescription: string;
  rows: ProjectRow[];
  /** The changes the project's checkouts need. */
  changesFor: (project: string, checkouts: ProjectCheckout[]) => CheckoutChange[];
  /** Saves a value in the setup repo: for every machine with `machine` null, and 'none' to follow. */
  save: (id: string, project: string, machine: string | null, value: 'on' | 'off' | null) => Promise<void>;
  /** Makes one machine's ready changes, saying how many worked. */
  apply: (machine: string, changes: CheckoutChange[]) => Promise<{ done: number; failed: number }>;
}) {
  const { t } = useI18n();
  const projects = useFleetProjects();
  const [scans, setScans] = useState<MachineProjects[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    let current = true;
    getProjects().then((next) => { if (current) setScans(next); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  const scope = useSyncScope();
  const project = scope.project;
  const checkouts = useMemo(
    () => (project ? projectCheckouts(scans, project).filter((checkout) => !scope.machine || checkout.machine === scope.machine) : []),
    [scans, project, scope.machine],
  );
  const machines = [...new Set(checkouts.map((checkout) => checkout.machine))];
  const changes = useMemo(() => (project ? changesFor(project, checkouts) : []), [changesFor, project, checkouts]);
  const ready = changes.filter((change) => !change.blocked);

  const saveValue = async (id: string, machine: string | null, value: Value) => {
    if (!project) return;
    setSaving(true);
    setError(null);
    try {
      await save(id, project, machine, value === 'none' ? null : value);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (!projects.length) return null;
  if (!project) {
    // At All projects: the projects with values of their own, each a way into its scope.
    const withValues = projects.filter((entry) => rows.some((row) => row.projects[projectSettingsKey(entry.key)]));
    return (
      <TableCard title={<span className="flex items-center gap-1.5">{title}<SectionAbout title={title} description={description} /></span>}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
          {withValues.length ? (
            <>
              <span>{t('projectCheckouts.withValues')}</span>
              {withValues.map((entry) => (
                <Button key={entry.key} variant="outline" size="xs" onClick={() => setSyncProject(entry.key)}>
                  <FolderGit2 aria-hidden="true" />
                  {projectLabel(entry.key, projects)}
                </Button>
              ))}
            </>
          ) : t('projectCheckouts.pickAbove')}
        </p>
      </TableCard>
    );
  }
  const onOff = (value: 'on' | 'off') => t(value === 'on' ? 'projectCheckouts.on' : 'projectCheckouts.off');

  return (
    <TableCard
      title={<span className="flex items-center gap-1.5">{title}<SectionAbout title={title} description={description} /></span>}
      toolbar={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={!ready.length} disabledReason={ready.length ? undefined : t('projectCheckouts.inStep')} onClick={() => setReviewing(true)}>
            {ready.length
              ? t(ready.length === 1 ? 'projectCheckouts.bring.one' : 'projectCheckouts.bring.other', { count: ready.length })
              : t('projectCheckouts.bring.none')}
          </Button>
        </div>
      }
    >
      {machines.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{column}</TableHead>
              <TableHead className="min-w-40">{t('projectCheckouts.everyMachine')}</TableHead>
              {machines.map((machine) => <TableHead key={machine} className="min-w-44"><MachinePill name={machine} size="sm" /></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const all: Value = row.projects[projectSettingsKey(project)]?.all === 'on' ? 'on' : row.projects[projectSettingsKey(project)]?.all === 'off' ? 'off' : 'none';
              return (
                <TableRow key={row.id}>
                  <NameCell name={row.name} note={row.note} />
                  <TableCell className="text-xs">
                    <ValueMenu
                      value={all}
                      label={all === 'none' ? t('projectCheckouts.followsMachine') : onOff(all)}
                      follow={t('projectCheckouts.followsMachine')}
                      busy={saving}
                      aria={t('projectCheckouts.valueAria', { name: row.id, place: projectLabel(project, projects) })}
                      onValue={(value) => void saveValue(row.id, null, value)}
                    />
                  </TableCell>
                  {machines.map((machine) => {
                    const wanted = projectValueAt(row.projects, project, machine);
                    const own: Value = wanted?.own ? wanted.value : 'none';
                    const standing = checkoutsStanding(changes, checkouts, machine, row.id);
                    return (
                      <TableCell key={machine} className="text-xs">
                        <div className="flex flex-col items-start gap-0.5">
                          <ValueMenu
                            value={own}
                            label={wanted ? onOff(wanted.value) : t('projectCheckouts.followsMachine')}
                            muted={own === 'none'}
                            follow={t('projectCheckouts.followsProject')}
                            busy={saving}
                            aria={t('projectCheckouts.valueAria', { name: row.id, place: t('machineScope.layers.projectOn', { project: projectLabel(project, projects), machine }) })}
                            onValue={(value) => void saveValue(row.id, machine, value)}
                          />
                          {wanted ? (
                            <span className={cn('text-xs', standing.behind ? (standing.blocked ? 'text-error-foreground' : 'text-warning-foreground') : 'text-muted-foreground')}>
                              {standing.blocked
                                ? t(BLOCKED[standing.blocked])
                                : standing.behind
                                  ? t(standing.total === 1 ? 'projectCheckouts.behind.one' : 'projectCheckouts.behind.other', { behind: standing.behind, total: standing.total })
                                  : t(standing.total === 1 ? 'projectCheckouts.inStep.one' : 'projectCheckouts.inStep.other', { count: standing.total })}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <TableEmpty>{scope.machine ? t('projectCheckouts.noCheckoutsOn', { machine: scope.machine }) : t('projectCheckouts.noCheckouts')}</TableEmpty>
      )}
      {error ? <p className="px-4 py-2 text-xs text-error-foreground" role="alert">{error}</p> : null}
      {reviewing ? (
        <CheckoutReview
          project={projectLabel(project, projects)}
          description={reviewDescription}
          rows={rows}
          changes={ready}
          apply={apply}
          onClose={() => setReviewing(false)}
          onDone={(next) => { setScans(next); setReviewing(false); }}
        />
      ) : null}
    </TableCard>
  );
}

function ValueMenu({ value, label, muted = false, follow, busy, aria, onValue }: {
  value: Value;
  label: string;
  muted?: boolean;
  follow: string;
  busy: boolean;
  aria: string;
  onValue: (value: Value) => void;
}) {
  const { t } = useI18n();
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="xs" disabled={busy} aria-label={aria} />} className={cn('-ms-2 max-w-48', muted && 'text-muted-foreground')}>
        <span className="truncate">{label}</span>
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>{t('projectCheckouts.inCheckouts')}</MenuGroupLabel>
          <MenuRadioGroup value={value} onValueChange={(next: string) => onValue(next as Value)}>
            <MenuRadioItem value="on" closeOnClick>{t('projectCheckouts.on')}</MenuRadioItem>
            <MenuRadioItem value="off" closeOnClick>{t('projectCheckouts.off')}</MenuRadioItem>
            <MenuRadioItem value="none" closeOnClick>{follow}</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The checkout changes, machine by machine; then the machines scanned again. */
export function CheckoutReview({ project, description, rows, changes, left = [], label, apply, onClose, onDone }: {
  project: string;
  description: string;
  rows: Pick<ProjectRow, 'id' | 'name'>[];
  changes: CheckoutChange[];
  /** Blocked changes, listed with why Arbor leaves them so the review doesn't read as covering every checkout. */
  left?: CheckoutChange[];
  /** What a change does, when it isn't turning something on or off. */
  label?: (change: CheckoutChange, name: string) => string;
  apply: (machine: string, changes: CheckoutChange[]) => Promise<{ done: number; failed: number }>;
  onClose: () => void;
  onDone: (scans: MachineProjects[]) => void;
}) {
  const { t } = useI18n();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setRunning(true);
    setError(null);
    let done = 0;
    let failed = 0;
    try {
      for (const [machine, list] of readyByMachine(changes)) {
        const counts = await apply(machine, list);
        done += counts.done;
        failed += counts.failed;
        await scanProjects(machine).catch(() => undefined);
      }
      toast({ kind: failed ? 'error' : 'success', title: t(failed ? 'projectCheckouts.appliedSome' : 'projectCheckouts.applied', { done, failed }) });
      onDone(await getProjects());
    } catch (reason) {
      setError(String(reason));
      setRunning(false);
    }
  };
  const nameOf = (id: string) => rows.find((row) => row.id === id)?.name ?? id;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !running) onClose(); }}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('projectCheckouts.reviewTitle', { project })}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col divide-y divide-border/60 text-sm">
            {changes.map((change) => (
              <li key={`${change.machine}\u0000${change.checkout}\u0000${change.target}`} className="flex items-center gap-3 py-2">
                <MachinePill name={change.machine} size="sm" />
                <MiddleTruncate value={change.checkout} className="min-w-0 flex-1 font-mono text-xs" />
                <span className="shrink-0">{label ? label(change, nameOf(change.target)) : t(change.on ? 'projectCheckouts.turnOn' : 'projectCheckouts.turnOff', { name: nameOf(change.target) })}</span>
              </li>
            ))}
            {left.map((change) => (
              <li key={`${change.machine}\u0000${change.checkout}\u0000${change.target}`} className="flex items-center gap-3 py-2 text-muted-foreground">
                <MachinePill name={change.machine} size="sm" />
                <MiddleTruncate value={change.checkout} className="min-w-0 flex-1 font-mono text-xs" />
                <span className="shrink-0 text-xs">{change.blocked ? t(BLOCKED[change.blocked]) : null}</span>
              </li>
            ))}
          </ul>
          {error ? <p className="pt-3 text-xs text-error-foreground" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={running} onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={running} onClick={() => void run()}>
            {running ? <Spinner /> : null}
            {t(changes.length === 1 ? 'projectCheckouts.apply.one' : 'projectCheckouts.apply.other', { count: changes.length })}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

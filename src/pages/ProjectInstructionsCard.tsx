import { useEffect, useMemo, useState } from 'react';
import { FolderGit2, Pencil, Plus } from '../components/ui/icons';
import { SectionAbout } from '../components/layout/settings';
import { projectLabel, useFleetProjects } from '../components/layout/machineScope';
import { MachinePill } from '../components/identity/Identity';
import { Button } from '../components/ui/button';
import { TableCard, TableEmpty } from '../components/ui/data-table';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../components/ui/dialog';
import { Spinner } from '../components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Textarea } from '../components/ui/textarea';
import { toast } from '../components/ui/toast';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { formatBytes } from '../services/machineHealth';
import { projectCheckouts, type CheckoutChange } from '../services/projectCheckouts';
import {
  applyCheckoutInstructions,
  hasCodex,
  INSTRUCTION_FILES,
  instructionChanges,
  instructionFileName,
  instructionsChanges,
  projectsWithText,
  readProjectInstructions,
  repoText,
  setProjectInstructions,
  textOn,
} from '../services/projectInstructions';
import { getProjects } from '../services/setupProjects';
import { setSyncProject, useSyncScope } from '../services/syncScope';
import type { InstructionFile, MachineProjects, SetupMachine, SetupRepo } from '../native/types';
import { CheckoutReview } from './ProjectCheckoutsCard';
import { NameCell } from './SetupNameCell';

/** Where an edit is for: every machine, or one. */
type Editing = { machine: string | null };

/**
 * Sync › Repo: a project's own instructions, kept in the setup repo for every machine and for one, and copied into each
 * of the project's checkouts: CLAUDE.local.md for Claude Code, and AGENTS.override.md where the machine has Codex.
 * Sync's scope sentence picks the project; at All projects the card lists the projects that have text.
 */
export function ProjectInstructionsCard({ repo, machines: setupMachines, onRepo }: { repo: SetupRepo; machines: SetupMachine[]; onRepo: (repo: SetupRepo) => void }) {
  const { t } = useI18n();
  const projects = useFleetProjects();
  const [scans, setScans] = useState<MachineProjects[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
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
  const codex = (machine: string) => hasCodex(setupMachines, machine);
  const changes = useMemo(
    () => (project ? instructionChanges(repo.instructions, checkouts, project, (machine) => hasCodex(setupMachines, machine)) : []),
    [repo.instructions, checkouts, project, setupMachines],
  );
  const ready = changes.filter((change) => !change.blocked);
  const title = t('projectInstructions.title');
  const heading = <span className="flex items-center gap-1.5">{title}<SectionAbout title={title} description={t('projectInstructions.description')} /></span>;

  if (!projects.length) return null;
  if (!project) {
    const withText = projectsWithText(repo.instructions);
    return (
      <TableCard title={heading}>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
          {withText.length ? (
            <>
              <span>{t('projectInstructions.withText')}</span>
              {withText.map((key) => (
                <Button key={key} variant="outline" size="xs" onClick={() => setSyncProject(key)}>
                  <FolderGit2 aria-hidden="true" />
                  {projectLabel(key, projects)}
                </Button>
              ))}
            </>
          ) : t('projectCheckouts.pickAbove')}
        </p>
      </TableCard>
    );
  }

  const label = projectLabel(project, projects);
  const every = repoText(repo.instructions, project, null);
  const lines = (size: number) => t('projectInstructions.size', { size: formatBytes(size) });
  /** How a machine's checkouts stand for one file: what's left to write, then anything Arbor leaves and why. */
  const standingLines = (machine: string, file: InstructionFile): { text: string; tone: 'muted' | 'warning' | 'error' }[] => {
    if (file === 'agentsOverride' && !codex(machine)) return [{ text: t('projectInstructions.noCodex'), tone: 'muted' }];
    const mine = changes.filter((change) => change.machine === machine && change.target === file);
    const total = checkouts.filter((checkout) => checkout.machine === machine).length;
    const behind = mine.filter((change) => !change.blocked).length;
    const lines: { text: string; tone: 'muted' | 'warning' | 'error' }[] = [];
    if (behind) lines.push({ text: t(total === 1 ? 'projectCheckouts.behind.one' : 'projectCheckouts.behind.other', { behind, total }), tone: 'warning' });
    else if (mine.length && mine.length < total) lines.push({ text: t('projectInstructions.inStepOf', { count: total - mine.length, total }), tone: 'muted' });
    for (const blocked of ['own', 'seen'] as const) {
      const count = mine.filter((change) => change.blocked === blocked).length;
      if (!count) continue;
      const key = blocked === 'own'
        ? (count === 1 ? 'projectInstructions.blocked.own.one' : 'projectInstructions.blocked.own.other')
        : (count === 1 ? 'projectInstructions.blocked.seen.one' : 'projectInstructions.blocked.seen.other');
      lines.push({ text: t(key, { count, file: instructionFileName(file) }), tone: 'error' });
    }
    if (lines.length) return lines;
    if (!textOn(repo.instructions, project, machine)) return [{ text: t('projectInstructions.nothing'), tone: 'muted' }];
    return [{ text: t(total === 1 ? 'projectCheckouts.inStep.one' : 'projectCheckouts.inStep.other', { count: total }), tone: 'muted' }];
  };

  return (
    <TableCard
      title={heading}
      toolbar={
        <Button variant="outline" size="sm" disabled={!ready.length} disabledReason={ready.length ? undefined : t('projectCheckouts.inStep')} onClick={() => setReviewing(true)}>
          {ready.length
            ? t(ready.length === 1 ? 'projectCheckouts.bring.one' : 'projectCheckouts.bring.other', { count: ready.length })
            : t('projectCheckouts.bring.none')}
        </Button>
      }
    >
      {machines.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-52 bg-card">{t('projectInstructions.column')}</TableHead>
              <TableHead className="min-w-40">{t('projectCheckouts.everyMachine')}</TableHead>
              {machines.map((machine) => <TableHead key={machine} className="min-w-44"><MachinePill name={machine} size="sm" /></TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <NameCell name={t('projectInstructions.text')} note={t('projectInstructions.textNote')} />
              <TableCell className="text-xs">
                <TextButton
                  label={every ? lines(every.size) : t('projectInstructions.add')}
                  has={Boolean(every)}
                  aria={t('projectInstructions.editAria', { place: label })}
                  onClick={() => setEditing({ machine: null })}
                />
              </TableCell>
              {machines.map((machine) => {
                const own = repoText(repo.instructions, project, machine);
                return (
                  <TableCell key={machine} className="text-xs">
                    <div className="flex flex-col items-start gap-0.5">
                      <TextButton
                        label={own ? t('projectInstructions.own', { size: lines(own.size) }) : every ? t('projectInstructions.sameAsEvery') : t('projectInstructions.add')}
                        has={Boolean(own)}
                        aria={t('projectInstructions.editAria', { place: t('machineScope.layers.projectOn', { project: label, machine }) })}
                        onClick={() => setEditing({ machine })}
                      />
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
            {INSTRUCTION_FILES.map((file) => (
              <TableRow key={file}>
                <NameCell name={instructionFileName(file)} note={t(file === 'claudeLocal' ? 'projectInstructions.claudeNote' : 'projectInstructions.codexNote')} />
                <TableCell className="text-xs text-muted-foreground">{t(file === 'claudeLocal' ? 'projectInstructions.claudeEvery' : 'projectInstructions.codexEvery')}</TableCell>
                {machines.map((machine) => {
                  return (
                    <TableCell key={machine} className="text-xs">
                      <div className="flex flex-col items-start gap-0.5">
                        {standingLines(machine, file).map((line) => (
                          <span key={line.text} className={cn(line.tone === 'error' ? 'text-error-foreground' : line.tone === 'warning' ? 'text-warning-foreground' : 'text-muted-foreground')}>
                            {line.text}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <TableEmpty>{scope.machine ? t('projectCheckouts.noCheckoutsOn', { machine: scope.machine }) : t('projectCheckouts.noCheckouts')}</TableEmpty>
      )}
      {editing ? (
        <EditInstructions
          repo={repo.path}
          project={project}
          place={editing.machine ? t('machineScope.layers.projectOn', { project: label, machine: editing.machine }) : label}
          machine={editing.machine}
          inherited={Boolean(editing.machine && every)}
          onClose={() => setEditing(null)}
          onSaved={(next) => { onRepo(next); setEditing(null); }}
        />
      ) : null}
      {reviewing ? (
        <CheckoutReview
          project={label}
          description={t('projectInstructions.reviewDescription')}
          rows={INSTRUCTION_FILES.map((file) => ({ id: file, name: instructionFileName(file) }))}
          changes={ready}
          label={(change: CheckoutChange, name: string) => t(change.on ? 'projectInstructions.write' : 'projectInstructions.empty', { name })}
          apply={async (machine, list) => {
            const results = await applyCheckoutInstructions(repo.path, project, machine, instructionsChanges(list));
            const done = results.filter((result) => result.outcome === 'done' || result.outcome === 'already').length;
            return { done, failed: results.length - done };
          }}
          onClose={() => setReviewing(false)}
          onDone={(next) => { setScans(next); setReviewing(false); }}
        />
      ) : null}
    </TableCard>
  );
}

function TextButton({ label, has, aria, onClick }: { label: string; has: boolean; aria: string; onClick: () => void }) {
  return (
    <Button variant="ghost-muted" size="xs" aria-label={aria} className={cn('-ms-2 max-w-48', !has && 'text-muted-foreground')} onClick={onClick}>
      {has ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </Button>
  );
}

/** The project's text for every machine or one, read from the repo's last commit and committed back on save. */
function EditInstructions({ repo, project, place, machine, inherited, onClose, onSaved }: {
  repo: string;
  project: string;
  place: string;
  machine: string | null;
  /** The machine would otherwise have every machine's text. */
  inherited: boolean;
  onClose: () => void;
  onSaved: (repo: SetupRepo) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [had, setHad] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    readProjectInstructions(repo, project, machine)
      .then((found) => { if (current) { setText(found ?? ''); setHad(found !== null); } })
      .catch((reason: unknown) => { if (current) { setText(''); setError(String(reason)); } });
    return () => { current = false; };
  }, [repo, project, machine]);

  const save = async (next: string | null) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await setProjectInstructions(repo, project, machine, next);
      toast({ kind: 'success', title: t(next === null ? 'projectInstructions.removed' : 'projectInstructions.saved', { place }) });
      onSaved(saved);
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('projectInstructions.editTitle', { place })}</DialogTitle>
          <DialogDescription>
            {t(machine ? (inherited ? 'projectInstructions.editMachineInherited' : 'projectInstructions.editMachine') : 'projectInstructions.editEvery', { machine: machine ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {text === null ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner />{t('projectInstructions.loading')}</p>
          ) : (
            <Textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-64 font-mono text-xs"
              placeholder={t('projectInstructions.placeholder')}
              aria-label={t('projectInstructions.editAria', { place })}
              disabled={saving}
            />
          )}
          {error ? <p className="pt-3 text-xs text-error-foreground" role="alert">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          {had ? (
            <Button variant="destructive-outline" className="me-auto" disabled={saving} onClick={() => void save(null)}>
              {t(machine ? 'projectInstructions.removeOwn' : 'projectInstructions.remove')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={saving} onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={saving || text === null || !text.trim()} onClick={() => void save(text)}>
            {saving ? <Spinner /> : null}
            {t('projectInstructions.save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

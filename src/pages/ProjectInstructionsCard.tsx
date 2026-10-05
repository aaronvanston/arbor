import { useEffect, useMemo, useState } from 'react';
import { projectLabel, useFleetProjects } from '../components/layout/machineScope';
import { Button } from '../components/ui/button';
import { useI18n } from '../i18n';
import { projectCheckouts, type CheckoutChange } from '../services/projectCheckouts';
import {
  applyCheckoutInstructions,
  hasCodex,
  INSTRUCTION_FILES,
  instructionChanges,
  instructionFileName,
  instructionsChanges,
} from '../services/projectInstructions';
import { getProjects } from '../services/setupProjects';
import type { MachineProjects, SetupMachine, SetupRepo } from '../native/types';
import { BLOCKED, CheckoutReview } from './ProjectCheckoutsCard';

/**
 * A project's own instructions, as the repo browser shows beside one of their files: how many of the project's checkouts
 * have the repo's last commit of them, and the review that brings the rest in line. Claude Code's checkouts get
 * CLAUDE.local.md, and AGENTS.override.md too where the machine has Codex.
 */
export function ProjectInstructionsStanding({ repo, machines, project }: { repo: SetupRepo; machines: SetupMachine[]; project: string }) {
  const { t } = useI18n();
  const projects = useFleetProjects();
  const [scans, setScans] = useState<MachineProjects[] | null>(null);
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    let current = true;
    getProjects().then((next) => { if (current) setScans(next); }).catch(() => undefined);
    return () => { current = false; };
  }, []);

  const checkouts = useMemo(() => (scans ? projectCheckouts(scans, project) : []), [scans, project]);
  const changes = useMemo(
    () => instructionChanges(repo.instructions, checkouts, project, (machine) => hasCodex(machines, machine)),
    [repo.instructions, checkouts, project, machines],
  );
  const ready = changes.filter((change) => !change.blocked);
  // A file of someone's own, or one the checkout's version control would pick up, keeps the checkout out of step, so
  // the button doesn't say otherwise.
  const left = changes.filter((change) => change.blocked);
  if (!scans) return null;
  if (!checkouts.length) return <span>{t('projectCheckouts.noCheckouts')}</span>;
  const onMachines = new Set(checkouts.map((checkout) => checkout.machine)).size;
  return (
    <span className="flex items-center gap-2">
      <span>{t(onMachines === 1 ? 'repo.project.checkouts.one' : 'repo.project.checkouts.other', { count: checkouts.length, machines: onMachines })}</span>
      <Button
        variant="outline"
        size="xs"
        disabled={!ready.length}
        disabledReason={ready.length ? undefined : left.length ? [...new Set(left.map((change) => t(BLOCKED[change.blocked ?? 'own'])))].join('. ') : t('projectCheckouts.inStep')}
        onClick={() => setReviewing(true)}
      >
        {ready.length
          ? t(ready.length === 1 ? 'projectCheckouts.bring.one' : 'projectCheckouts.bring.other', { count: ready.length })
          : left.length
            ? t(left.length === 1 ? 'projectInstructions.left.one' : 'projectInstructions.left.other', { count: left.length })
            : t('projectCheckouts.bring.none')}
      </Button>
      {reviewing ? (
        <CheckoutReview
          project={projectLabel(project, projects)}
          description={t('projectInstructions.reviewDescription')}
          rows={INSTRUCTION_FILES.map((file) => ({ id: file, name: instructionFileName(file) }))}
          changes={ready}
          left={left}
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
    </span>
  );
}

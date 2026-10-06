import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import type { ProjectCheckout } from '../services/projectCheckouts';
import { applyCheckoutSkills, homeSkill, projectSkillChanges, setSetupSkillProject, skillChanges } from '../services/setupSkillProjects';
import { getSetupRepo, storedSetupRepo } from '../services/setupSync';
import type { SetupMachine, SetupRepo } from '../native/types';
import { ProjectCheckoutsCard, type ProjectRow } from './ProjectCheckoutsCard';

/**
 * Sync › Library › Skills by machine, In a project: a project's own value for each skill the setup repo has, set in each checkout's own
 * skillOverrides. Shown once there's a setup repo with skills.
 */
export function ProjectSkillsCard({ machines, only = null }: {
  machines: SetupMachine[];
  /** One skill's row alone, on its Library page. */
  only?: string | null;
}) {
  const { t } = useI18n();
  const [path] = useState(storedSetupRepo);
  const [repo, setRepo] = useState<SetupRepo | null>(null);

  useEffect(() => {
    if (!path) return undefined;
    let current = true;
    getSetupRepo(path).then((next) => { if (current) setRepo(next); }).catch(() => { if (current) setRepo(null); });
    return () => { current = false; };
  }, [path]);

  const values = repo?.skillProjects;
  // The repo's skills, and any a project names that the repo no longer has, so a value can still be cleared.
  const names = useMemo(
    () => [...new Set([...(repo?.skills ?? []).map((skill) => skill.name), ...Object.keys(values ?? {})])].sort(),
    [repo, values],
  );
  const rows = useMemo<ProjectRow[]>(
    () => names.filter((name) => only === null || name === only).map((name) => ({ id: name, name, note: null, projects: values?.[name] ?? {} })),
    [names, values, only],
  );
  const changesFor = useCallback(
    (project: string, checkouts: ProjectCheckout[]) => projectSkillChanges(names, values ?? {}, checkouts, project, (machine, skill) => homeSkill(machines, machine, skill)),
    [names, values, machines],
  );

  if (!path || !repo || !rows.length) return null;
  return (
    <ProjectCheckoutsCard
      title={t('setup.skills.projects.title')}
      description={t('setup.skills.projects.description')}
      column={t('setup.skills.projects.column')}
      reviewDescription={t('setup.skills.projects.reviewDescription')}
      rows={rows}
      changesFor={changesFor}
      save={async (id, project, machine, value) => setRepo(await setSetupSkillProject(path, id, project, machine, value))}
      apply={async (machine, changes) => {
        const results = await applyCheckoutSkills(machine, skillChanges(changes));
        const done = results.filter((result) => result.outcome === 'done' || result.outcome === 'already').length;
        return { done, failed: results.length - done };
      }}
    />
  );
}

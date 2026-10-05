import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import type { ProjectCheckout } from '../services/projectCheckouts';
import { applyCheckoutMcp, homeServer, mcpChanges, projectMcpChanges, repoDefines, setSetupMcpProject } from '../services/setupMcpProjects';
import { getSetupRepo } from '../services/setupSync';
import type { McpRegistry, SetupMachine, SetupRepo } from '../native/types';
import { ProjectCheckoutsCard, type ProjectRow } from './ProjectCheckoutsCard';

/**
 * Sync › Library › Plugins by machine, In a project: a project's own value for each Claude Code server the setup repo defines, denied
 * in each checkout's settings.local.json when off and set up in Claude Code's local scope there when on.
 */
export function ProjectMcpCard({ repo, registry, machines }: { repo: string; registry: McpRegistry; machines: SetupMachine[] }) {
  const { t } = useI18n();
  const [setup, setSetup] = useState<SetupRepo | null>(null);

  useEffect(() => {
    let current = true;
    getSetupRepo(repo).then((next) => { if (current) setSetup(next); }).catch(() => { if (current) setSetup(null); });
    return () => { current = false; };
  }, [repo]);

  const values = setup?.mcpProjects;
  // The repo's Claude Code servers, and any a project names that the repo no longer has, so a value can still be cleared.
  const names = useMemo(
    () => [...new Set([...registry.servers.filter((server) => server.claude).map((server) => server.name), ...Object.keys(values ?? {})])].sort(),
    [registry, values],
  );
  const rows = useMemo<ProjectRow[]>(
    () => names.map((name) => ({ id: name, name, note: registry.servers.find((server) => server.name === name)?.claude?.place ?? null, projects: values?.[name] ?? {} })),
    [names, registry, values],
  );
  const changesFor = useCallback(
    (project: string, checkouts: ProjectCheckout[]) => projectMcpChanges(
      names, values ?? {}, checkouts, project,
      (machine, server) => homeServer(machines, machine, server),
      (machine, server) => repoDefines(registry, machine, server),
    ),
    [names, values, machines, registry],
  );

  if (!setup || !rows.length) return null;
  return (
    <ProjectCheckoutsCard
      title={t('setup.mcp.projects.title')}
      description={t('setup.mcp.projects.description')}
      column={t('setup.mcp.projects.column')}
      reviewDescription={t('setup.mcp.projects.reviewDescription')}
      rows={rows}
      changesFor={changesFor}
      save={async (id, project, machine, value) => setSetup(await setSetupMcpProject(repo, id, project, machine, value))}
      apply={async (machine, changes) => {
        const results = await applyCheckoutMcp(repo, machine, mcpChanges(changes));
        const done = results.filter((result) => result.outcome === 'done' || result.outcome === 'already').length;
        return { done, failed: results.length - done };
      }}
    />
  );
}

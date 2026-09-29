import { useCallback, useMemo } from 'react';
import { useI18n } from '../i18n';
import type { ProjectCheckout } from '../services/projectCheckouts';
import { setSetupPluginProject } from '../services/setupPluginRepo';
import { homePlugin, pluginChanges, projectChanges } from '../services/setupPluginProjects';
import { applyPluginChanges, type ExtensionsView } from '../services/setupPlugins';
import type { RepoPlugin } from '../native/types';
import { ProjectCheckoutsCard, type ProjectRow } from './ProjectCheckoutsCard';

/**
 * Sync › Plugins, In a project: a project's own value for each plugin the setup repo lists, brought into each checkout
 * with Claude Code's own `plugin enable|disable --scope local`.
 */
export function ProjectPluginsCard({ repo, plugins, view, onPlugins }: {
  repo: string;
  plugins: RepoPlugin[];
  view: ExtensionsView;
  onPlugins: (plugins: RepoPlugin[]) => void;
}) {
  const { t } = useI18n();
  const rows = useMemo<ProjectRow[]>(
    () => plugins.map((plugin) => ({ id: plugin.id, name: plugin.id.split('@')[0] ?? plugin.id, note: plugin.id.split('@')[1] ?? null, projects: plugin.projects })),
    [plugins],
  );
  const changesFor = useCallback(
    (project: string, checkouts: ProjectCheckout[]) => projectChanges(plugins, checkouts, project, (machine, plugin) => homePlugin(view, machine, plugin)),
    [plugins, view],
  );
  return (
    <ProjectCheckoutsCard
      title={t('setup.plugins.projects.title')}
      description={t('setup.plugins.projects.description')}
      column={t('setup.plugins.column.plugin')}
      reviewDescription={t('setup.plugins.projects.reviewDescription')}
      rows={rows}
      changesFor={changesFor}
      save={async (id, project, machine, value) => onPlugins((await setSetupPluginProject(repo, id, project, machine, value)).plugins)}
      apply={async (machine, changes) => {
        const results = await applyPluginChanges(machine, pluginChanges(changes));
        const done = results.filter((result) => result.outcome === 'done' || result.outcome === 'already').length;
        return { done, failed: results.length - done };
      }}
    />
  );
}

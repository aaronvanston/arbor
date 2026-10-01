import { Layers, TriangleAlert } from '../components/ui/icons';
import { projectsLensAction } from '../components/ProjectsLens';
import { MachineCrumb } from '../components/layout/MachineCrumb';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { RefreshIcon } from '../components/ui/refresh-icon';
import { Spinner } from '../components/ui/spinner';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { WithShortcut } from '../components/ShortcutKbd';
import { useSetupInventory } from '../hooks/useSetupInventory';
import { useShortcut } from '../hooks/useShortcuts';
import { useI18n } from '../i18n';
import { sessionsView, type AppView, type SessionsParams } from '../navigation';
import { scanProjects } from '../services/setupProjects';
import type { ViewChange } from '../services/viewHistory';
import { SetupProjects } from './SetupProjects';

/**
 * Sessions › Projects' Checkouts: each repo's branches and worktrees on each machine, with the ones that can go. It was
 * Sync's Projects and is that view as it was, read from the same setup scans, under Projects with its Activity.
 */
export function SessionsCheckoutsPage({ params, onViewChange }: {
  params?: SessionsParams;
  onViewChange?: (view: AppView, how?: ViewChange) => void;
}) {
  const { t } = useI18n();
  const { inventory, error } = useSetupInventory();
  const every = inventory?.machines ?? [];
  // The machine the breadcrumb narrowed Projects to, or every machine.
  const picked = params?.machine ?? '';
  const machines = picked ? every.filter((machine) => machine.machine === picked) : every;
  const scanning = machines.some((machine) => machine.scanning);
  // Every answering machine shown is looked at; a scan already running there is left to finish.
  const scanAll = () => {
    for (const machine of machines) {
      if (machine.reachable) void scanProjects(machine.machine).catch(() => undefined);
    }
  };
  useShortcut('page.refresh', () => {
    if (!scanning) scanAll();
  }, machines.length > 0);
  // Activity is its own step, so Back returns here.
  const chooseLens = (lens: SessionsParams['lens']) => onViewChange?.(sessionsView({ ...params, tab: 'projects', lens }), 'push');

  return (
    <Page width="main">
      <PageTopbar
        collapsible={[projectsLensAction('checkouts', chooseLens)]}
        actions={machines.length ? (
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" disabled={scanning} focusableWhenDisabled onClick={scanAll} />}>
              <RefreshIcon refreshing={scanning} />
              {scanning ? t('setup.scanning') : t('setup.scan')}
            </TooltipTrigger>
            <TooltipPopup><WithShortcut id="page.refresh">{t('setup.scan')}</WithShortcut></TooltipPopup>
          </Tooltip>
        ) : undefined}
      >
        <PageBreadcrumb
          segments={[
            t('app.nav.sessions'),
            t('usage.tab.projects'),
            <MachineCrumb
              key="machine"
              machine={picked}
              machines={every.map((machine) => machine.machine)}
              onChange={(machine) => onViewChange?.(sessionsView({ ...params, tab: 'projects', lens: 'checkouts', machine }))}
            />,
          ]}
        />
      </PageTopbar>
      <PageBody gap="gap-5">
        {error ? (
          <Alert variant="error" icon={<TriangleAlert />}>
            <AlertDescription>{t('setup.loadFailed', { error })}</AlertDescription>
          </Alert>
        ) : null}
        {inventory === null ? (
          <p className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Spinner />
            {t('setup.loading')}
          </p>
        ) : !every.length ? (
          <Empty>
            <EmptyMedia><Layers /></EmptyMedia>
            <EmptyTitle>{t('setup.empty.title')}</EmptyTitle>
            <EmptyDescription>{t('setup.empty.description')}</EmptyDescription>
          </Empty>
        ) : (
          <SetupProjects machines={machines} />
        )}
      </PageBody>
    </Page>
  );
}

import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { HomeDashboard } from '../components/HomeDashboard';
import { HeavySessionBanner } from '../components/HeavySessionBanner';
import { ProviderStatusBanner } from '../components/ProviderStatusBanner';
import { ProxyChecksBanner } from '../components/ProxyChecksBanner';
import { sessionsView, type AppView } from '../navigation';
import { IdleUpdateNotice } from '../components/UpdateWhenIdle';

export function HomePage({ onNavigate, onAddMachine }: { onNavigate?: (view: AppView) => void; onAddMachine?: () => void }) {
  const { t } = useI18n();
  const { status: coreStatus } = useCoreRuntime();

  return (
    <Page width="main">
      <PageTopbar>
        <PageBreadcrumb segments={[t('app.nav.home')]} />
      </PageTopbar>
      <PageBody>
        <ProxyChecksBanner onNavigate={onNavigate} />
        <ProviderStatusBanner />
        <HeavySessionBanner onOpenSession={onNavigate ? (id) => onNavigate(sessionsView({ session: id })) : undefined} />
        {/* Outside the dashboard: a restart that failed on its own can leave the core down. */}
        <IdleUpdateNotice />
        <HomeDashboard coreReady={Boolean(coreStatus?.ready)} onNavigate={onNavigate} onAddMachine={onAddMachine} />
      </PageBody>
    </Page>
  );
}

import { Fragment, useState } from 'react';
import { ComputeLimits } from '../components/compute/ComputeLimits';
import { ComputeMix } from '../components/compute/ComputeMix';
import { ComputeStats } from '../components/compute/ComputeStats';
import { SandboxTable } from '../components/compute/SandboxTable';
import { SandboxView } from '../components/compute/SandboxView';
import { Page, PageBody, PageBreadcrumb, PageCrumbButton, PageTopbar } from '../components/layout/page';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { AlertCircle, Cloud, Info, RefreshCw } from '../components/ui/icons';
import { Skeleton } from '../components/ui/skeleton';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { requestFocus } from '../focusRequests';
import { useAgo } from '../hooks/useNow';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { computeSandboxView, computeView, type AppView, type ComputeParams } from '../navigation';
import type { ComputeProviderSnapshot } from '../native/types';
import { readCommandError } from '../services/commandError';
import {
  allSandboxes,
  dollarsShown,
  findProvider,
  findSandbox,
  formatReadAgo,
  rateLimitedListStale,
  refreshCompute,
  shownProviders,
  useCompute,
  type ComputeGrouping,
} from '../services/compute';
import { COMPUTE_PROVIDERS, computeProviderName, useConnectedComputeProviders } from '../services/computeHint';
import { agentsFigure } from '../services/computePage';
import { useQuotaClock } from '../services/quotaTime';

type Navigate = (view: AppView) => void;

/** A provider whose figures are an earlier read's: not answering, its key turned down, or asked too often a while. */
const isStale = (provider: ComputeProviderSnapshot, nowMs: number) =>
  provider.status === 'unreachable' || provider.status === 'refused' || rateLimitedListStale(provider, nowMs);

/** Opens Settings › Compute at its linking section. */
const openLinking = (onNavigate: Navigate) => {
  requestFocus('setting', 'compute.linking');
  onNavigate({ kind: 'settings', page: 'compute' });
};

/**
 * Fleet › Compute: cloud sandboxes from the connected providers. Every provider's (no params), one provider's
 * (`provider`), or one sandbox's own page (`provider` and `sandbox`). Everything here comes from the snapshot the
 * store follows; the page itself reads nothing on a timer.
 */
export function ComputePage({ params, onNavigate }: { params?: ComputeParams; onNavigate: Navigate }) {
  const { t } = useI18n();
  const { snapshot, error } = useCompute();
  const connected = useConnectedComputeProviders();
  const nowMs = useQuotaClock();
  const home = <PageCrumbButton onClick={() => onNavigate(computeView())}>{t('app.nav.compute')}</PageCrumbButton>;

  // With nothing connected the store never asks Rust (an old alert can still lead here), so there's nothing to wait for.
  if (!snapshot && !error && !connected.length) return <NoProvider onNavigate={onNavigate} />;

  if (!snapshot) {
    return (
      <Page width="main">
        <PageTopbar><PageBreadcrumb segments={[t('app.nav.compute')]} /></PageTopbar>
        <PageBody gap="gap-4">
          {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{t('compute.page.loadFailed', { error })}</AlertDescription></Alert> : <Skeleton className="h-64 rounded-2xl" aria-label={t('compute.page.loading')} />}
        </PageBody>
      </Page>
    );
  }

  if (!snapshot.providers.length) return <NoProvider onNavigate={onNavigate} />;

  if (params?.provider && params.sandbox) {
    const provider = params.provider;
    const sandbox = findSandbox(snapshot, provider, params.sandbox);
    return (
      <Page width="main">
        <PageTopbar>
          <PageBreadcrumb
            segments={[home, <PageCrumbButton key="provider" onClick={() => onNavigate(computeView(provider))}>{computeProviderName(provider)}</PageCrumbButton>, sandbox?.name ?? params.sandbox]}
          />
        </PageTopbar>
        <PageBody gap="gap-6">
          {/* Keyed, so going straight from one sandbox to another never draws the first one's readings under the second's name. */}
          {sandbox ? <SandboxView key={`${provider}/${sandbox.id}`} provider={provider} sandbox={sandbox} nowMs={nowMs} onNavigate={onNavigate} /> : (
            <Empty>
              <EmptyTitle>{t('compute.sandbox.gone')}</EmptyTitle>
              <Button variant="outline" size="sm" onClick={() => onNavigate(computeView(provider))}>{t('compute.sandbox.back')}</Button>
            </Empty>
          )}
        </PageBody>
      </Page>
    );
  }

  const providers = shownProviders(snapshot, params?.provider);
  const one = params?.provider ? findProvider(snapshot, params.provider) : undefined;
  return (
    <Page width="main">
      <PageTopbar actions={<CheckNow providers={providers} />}>
        <PageBreadcrumb segments={one ? [home, computeProviderName(one.id)] : [t('app.nav.compute')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {params?.provider && !one ? (
          <Empty>
            <EmptyTitle>{t('compute.page.goneProvider')}</EmptyTitle>
            <Button variant="outline" size="sm" onClick={() => onNavigate(computeView())}>{t('compute.sandbox.back')}</Button>
          </Empty>
        ) : (
          <ComputeOverview providers={providers} grouping={params?.group} nowMs={nowMs} onNavigate={onNavigate} />
        )}
      </PageBody>
    </Page>
  );
}

/** No provider connected: the way to connect one. */
function NoProvider({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  return (
    <Page width="main">
      <PageTopbar><PageBreadcrumb segments={[t('app.nav.compute')]} /></PageTopbar>
      <PageBody gap="gap-4">
        <Empty>
          <EmptyMedia><Cloud /></EmptyMedia>
          <EmptyTitle>{t('compute.page.noneTitle')}</EmptyTitle>
          <EmptyDescription>{t('compute.page.noneDescription')}</EmptyDescription>
          <Button variant="outline" size="sm" onClick={() => onNavigate({ kind: 'settings', page: 'compute' })}>{t('compute.page.openSettings')}</Button>
        </Empty>
      </PageBody>
    </Page>
  );
}

/** Checks every provider now; a check that fails says so in a toast, as the figures stay. */
function useCheckNow() {
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      await refreshCompute();
    } catch (failure) {
      toast({ title: readCommandError(failure).message, kind: 'error' });
    } finally {
      setChecking(false);
    }
  };
  return { checking, check };
}

/** "Read 12s ago" and the button that checks now. */
function CheckNow({ providers }: { providers: readonly ComputeProviderSnapshot[] }) {
  const { t } = useI18n();
  const { checking, check } = useCheckNow();
  const newest = providers.reduce<number | null>((latest, provider) => (provider.checkedAtMs !== null && (latest === null || provider.checkedAtMs > latest) ? provider.checkedAtMs : latest), null);
  const ago = useAgo(newest);
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs tabular-nums text-muted-foreground">{ago ? t('compute.readAgo', { ago }) : t('compute.notReadYet')}</span>
      <Button variant="ghost" size="icon-sm" onClick={() => void check()} aria-label={t('compute.checkNow')} title={t('compute.checkNow')} disabled={checking}>
        <RefreshCw className={cn(checking && 'animate-spin')} />
      </Button>
    </span>
  );
}

/** Every provider shown, or one: what's wrong with reading them, the figures, the table, the limits and the mix. */
export function ComputeOverview({ providers, grouping, nowMs, onNavigate }: {
  providers: ComputeProviderSnapshot[];
  /** The table's grouping the view asks for; without one it keeps the one it was left on. */
  grouping?: ComputeGrouping;
  nowMs: number;
  onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const sandboxes = allSandboxes(providers);
  const agents = agentsFigure(sandboxes);
  const stale = providers.length > 0 && providers.every((provider) => isStale(provider, nowMs));
  return (
    <>
      {providers.map((provider) => (
        <Fragment key={provider.id}>
          <ProviderBanner provider={provider} nowMs={nowMs} onNavigate={onNavigate} />
          {provider.listPartial ? <ListPartialNote provider={provider} /> : null}
        </Fragment>
      ))}
      {agents.own > 0 && agents.notLinked === agents.own ? (
        <Alert
          icon={<Info />}
          action={<Button variant="outline" size="sm" onClick={() => openLinking(onNavigate)}>{t('compute.page.howToLink')}</Button>}
        >
          <AlertDescription>{t('compute.page.noLinks')}</AlertDescription>
        </Alert>
      ) : null}
      <ComputeStats providers={providers} nowMs={nowMs} stale={stale} />
      <SandboxTable
        // A view that asks for a grouping opens the table again that way.
        key={grouping ?? 'kept'}
        providers={providers}
        grouping={grouping}
        nowMs={nowMs}
        dollars={dollarsShown(providers)}
        stale={stale}
        onOpen={(provider, sandboxId) => onNavigate(computeSandboxView(provider, sandboxId))}
      />
      <ComputeLimits providers={providers} nowMs={nowMs} stale={stale} />
      <ComputeMix sandboxes={sandboxes} />
    </>
  );
}

/**
 * What's wrong with reading a provider, above its figures: not answering, asking Arbor to slow down, a refused key,
 * limits it can't read.
 */
function ProviderBanner({ provider, nowMs, onNavigate }: { provider: ComputeProviderSnapshot; nowMs: number; onNavigate: Navigate }) {
  const { t } = useI18n();
  const name = computeProviderName(provider.id);
  if (provider.status === 'unreachable') {
    return (
      <Alert variant="warning" icon={<AlertCircle />} action={<TryAgain />}>
        <AlertDescription>{t('compute.page.unreachable', { provider: name, ago: formatReadAgo(provider, nowMs) ?? t('compute.notReadYet') })}</AlertDescription>
      </Alert>
    );
  }
  // No Try again here: asking again is what the provider asked Arbor not to do, and Arbor already waits as told.
  if (provider.status === 'rateLimited') {
    return (
      <Alert variant="warning" icon={<AlertCircle />}>
        <AlertDescription>{t('compute.page.rateLimited', { provider: name })}</AlertDescription>
      </Alert>
    );
  }
  if (provider.status === 'refused') {
    return (
      <Alert
        variant="error"
        icon={<AlertCircle />}
        action={<Button variant="outline" size="sm" onClick={() => onNavigate({ kind: 'settings', page: 'compute' })}>{t('compute.page.openSettings')}</Button>}
      >
        <AlertDescription>{t('compute.page.refused', { provider: name })}</AlertDescription>
      </Alert>
    );
  }
  if (provider.status === 'limitsNeedScope') {
    const scope = COMPUTE_PROVIDERS[provider.id].limitsScope;
    return (
      <Alert icon={<Info />}>
        <AlertDescription>{scope ? t('compute.page.limitsNeedScopeNamed', { provider: name, scope }) : t('compute.page.limitsNeedScope', { provider: name })}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

/** A list cut short at Arbor's page cap: whatever the status, some sandboxes (the oldest) may not be shown. */
function ListPartialNote({ provider }: { provider: ComputeProviderSnapshot }) {
  const { t } = useI18n();
  return (
    <Alert icon={<Info />}>
      <AlertDescription>{t('compute.page.listPartial', { provider: computeProviderName(provider.id) })}</AlertDescription>
    </Alert>
  );
}

/** Checks again now, for a provider that wasn't answering. */
function TryAgain() {
  const { t } = useI18n();
  const { checking, check } = useCheckNow();
  return (
    <Button variant="outline" size="sm" disabled={checking} onClick={() => void check()}>
      {checking ? <Spinner /> : null}
      {t('compute.page.tryAgain')}
    </Button>
  );
}

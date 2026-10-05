import { useEffect, useState, type ReactNode } from 'react';
import { clearFocusRequest, useFocusRequest } from '../focusRequests';
import { PoolDialog } from '../components/pools/PoolDialog';
import { PoolLimitsLine, PoolMembersTable, PoolPlan, PoolStandingBadge, ShareBar, useWhenFull } from '../components/pools/PoolHealth';
import { PoolRunsBlock, StartRunDialog } from '../components/PoolRuns';
import { PoolConnectDialog } from '../components/pools/PoolConnect';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '../components/ui/empty';
import { AlertCircle, ChevronRight, Network, Pencil, Play, Plus, TerminalSquare } from '../components/ui/icons';
import { Skeleton } from '../components/ui/skeleton';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { poolsView, type AppView, type PoolsParams } from '../navigation';
import type { HarnessRun, MachinePool, PoolPreview } from '../native/types';
import { newPool, poolStanding, usePools, usePoolsWatching } from '../services/pools';
import { poolRuns, useRuns } from '../services/runs';

/**
 * Fleet › Pools: every pool's health at a glance, or one pool's own page when the view names it. Changing a pool's
 * machines and limits is the same dialog as Settings › Pools.
 */
export function PoolsPage({ params, onNavigate }: { params?: PoolsParams; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { pools, previews, error } = usePools();
  usePoolsWatching();
  const { runs } = useRuns();
  const [editing, setEditing] = useState<MachinePool | null>(null);
  const [running, setRunning] = useState<MachinePool | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const open = params?.pool ? pools?.find((pool) => pool.id === params.pool) : undefined;
  // ⌘K's New session on a pool lands here and opens the dialog once the pool has loaded.
  const asked = useFocusRequest('pool-session');
  useEffect(() => {
    if (!asked || !pools) return;
    const pool = pools.find((entry) => entry.id === asked);
    if (pool && pool.members.length > 0) setRunning(pool);
    clearFocusRequest('pool-session');
  }, [asked, pools]);
  const previewOf = (pool: MachinePool) => previews.find((entry) => entry.pool === pool.id);
  const runsOf = (pool: MachinePool) => (runs ? poolRuns(runs, pool.id) : null);
  const dialogs = (
    <>
      <PoolDialog pool={editing} pools={pools ?? []} onClose={() => setEditing(null)} />
      <StartRunDialog pool={running} onClose={() => setRunning(null)} />
      <PoolConnectDialog poolId={connecting} onClose={() => setConnecting(null)} />
    </>
  );
  const startRun = (pool: MachinePool) => (
    <Button variant="outline" size="sm" onClick={() => setRunning(pool)} disabledReason={pool.members.length === 0 ? t('runs.needsMembers') : undefined}>
      <Play />{t('runs.start')}
    </Button>
  );

  if (params?.pool) {
    const back = (
      <button type="button" className="cursor-pointer hover:text-foreground" onClick={() => onNavigate(poolsView())}>{t('app.nav.pools')}</button>
    );
    return (
      <Page width="main">
        <PageTopbar
          actions={open ? (
            <>
              {startRun(open)}
              <Button variant="outline" size="sm" onClick={() => setConnecting(open.id)} disabledReason={open.members.length === 0 ? t('runs.needsMembers') : undefined}>
                <TerminalSquare />{t('pools.ssh.open')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(open)}><Pencil />{t('pools.edit')}</Button>
            </>
          ) : null}
        >
          <PageBreadcrumb segments={[back, open?.name ?? '']} />
        </PageTopbar>
        <PageBody gap="gap-4">
          {open ? (
            <PoolDetail pool={open} pools={pools ?? []} preview={previewOf(open)} runs={runsOf(open)} onNavigate={onNavigate} />
          ) : pools ? (
            <p className="text-sm text-muted-foreground">{t('pools.page.gone')}</p>
          ) : (
            <Skeleton className="h-96 rounded-2xl" />
          )}
          {dialogs}
        </PageBody>
      </Page>
    );
  }

  return (
    <Page width="main">
      <PageTopbar actions={<Button variant="outline" size="sm" onClick={() => setEditing(newPool())} disabled={!pools}><Plus />{t('pools.new')}</Button>}>
        <PageBreadcrumb segments={[t('app.nav.pools')]} />
      </PageTopbar>
      <PageBody gap="gap-4">
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        {!pools ? (
          error ? null : <Skeleton className="h-64 rounded-2xl" />
        ) : pools.length === 0 ? (
          <Empty>
            <EmptyMedia><Network /></EmptyMedia>
            <EmptyTitle>{t('pools.page.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{t('pools.page.emptyDescription')}</EmptyDescription>
            <Button variant="outline" size="sm" onClick={() => setEditing(newPool())}><Plus />{t('pools.new')}</Button>
          </Empty>
        ) : (
          <>
            <PoolsSummary pools={pools} previews={previews} runs={runs} />
            {pools.map((pool) => (
              <PoolCard
                key={pool.id}
                pool={pool}
                pools={pools}
                preview={previewOf(pool)}
                actions={(
                  <>
                    {startRun(pool)}
                    <Button variant="ghost" size="icon-sm" onClick={() => onNavigate(poolsView(pool.id))} aria-label={t('pools.page.open', { name: pool.name })} title={t('pools.page.open', { name: pool.name })}>
                      <ChevronRight />
                    </Button>
                  </>
                )}
                onOpen={() => onNavigate(poolsView(pool.id))}
              />
            ))}
          </>
        )}
        {dialogs}
      </PageBody>
    </Page>
  );
}

/** The fleet's pools in figures: how many would take a run now, and runs waiting or handed off today. */
function PoolsSummary({ pools, previews, runs }: { pools: MachinePool[]; previews: PoolPreview[]; runs: HarnessRun[] | null }) {
  const { t } = useI18n();
  const standings = pools.map((pool) => poolStanding(pool, previews.find((entry) => entry.pool === pool.id)).standing);
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const waiting = runs?.filter((run) => run.state === 'queued').length ?? 0;
  const today = runs?.filter((run) => (run.startedAtMs ?? run.queuedAtMs) >= dayAgo && run.state !== 'queued').length ?? 0;
  const full = standings.filter((standing) => standing === 'full').length;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl border border-border/70 bg-card px-4 py-4 sm:grid-cols-4" data-slot="pools-summary">
      <Figure label={t('pools.summary.withRoom')}>{standings.filter((standing) => standing === 'room').length}</Figure>
      <Figure label={t('pools.summary.full')} tone={full ? 'warning' : undefined}>{full}</Figure>
      <Figure label={t('pools.summary.waiting')} tone={waiting ? 'warning' : undefined}>{waiting}</Figure>
      <Figure label={t('pools.summary.today')}>{today}</Figure>
    </dl>
  );
}

function Figure({ label, tone, children }: { label: string; tone?: 'warning'; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-lg font-semibold tabular-nums', tone === 'warning' ? 'text-warning-foreground' : 'text-foreground')}>{children}</dd>
    </div>
  );
}

/** One pool on the overview: its standing, the next run's chances as a bar, each member's load, and its plan. */
function PoolCard({ pool, pools, preview, actions, onOpen }: {
  pool: MachinePool;
  pools: MachinePool[];
  preview: PoolPreview | undefined;
  actions: ReactNode;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5" data-slot="pool-card">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3 pb-2">
        <button type="button" className="flex min-w-0 cursor-pointer items-center gap-2 text-sm font-semibold hover:underline" onClick={onOpen}>
          <Network className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{pool.name}</span>
        </button>
        <PoolStandingBadge pool={pool} preview={preview} />
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </header>
      {pool.members.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">{t('pools.noMembers')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 px-4 pb-3">
            <span className="text-xs text-muted-foreground">{t('pools.page.shareTitle')}</span>
            <ShareBar preview={preview} />
          </div>
          <PoolMembersTable pool={pool} preview={preview} />
          <div className="border-t border-border/50 px-4 py-3">
            <PoolPlan pool={pool} pools={pools} preview={preview} />
          </div>
        </>
      )}
    </section>
  );
}

/**
 * A pool's own page: its standing and limits, its members with where the next run would go, and its recent runs.
 * Connecting over SSH is set up once, so it lives behind the Connect button instead of on the page.
 */
function PoolDetail({ pool, pools, preview, runs, onNavigate }: { pool: MachinePool; pools: MachinePool[]; preview: PoolPreview | undefined; runs: HarnessRun[] | null; onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const whenFull = useWhenFull(pool, pools);
  return (
    <>
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-foreground">{pool.name}</h2>
          <PoolStandingBadge pool={pool} preview={preview} />
        </div>
        <PoolLimitsLine pool={pool} className="text-sm" />
        <p className="text-sm text-muted-foreground">{t('pools.page.whenFull', { action: whenFull })}</p>
      </header>
      <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
        {pool.members.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">{t('pools.noMembers')}</p>
        ) : (
          <>
            <div className="flex flex-col gap-1.5 px-4 pt-3 pb-3">
              <span className="text-xs text-muted-foreground">{t('pools.page.shareTitle')}</span>
              <ShareBar preview={preview} />
            </div>
            <PoolMembersTable pool={pool} preview={preview} />
            <div className="border-t border-border/50 px-4 py-3">
              <PoolPlan pool={pool} pools={pools} preview={preview} explain />
            </div>
          </>
        )}
      </section>
      {runs ? (
        <section className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5">
          <h3 className="border-b border-border/50 px-4 py-3 text-sm font-medium">{t('runs.recent')}</h3>
          <PoolRunsBlock runs={runs} onNavigate={onNavigate} />
        </section>
      ) : null}
    </>
  );
}

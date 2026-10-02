import { useState } from 'react';
import { AlertCircle, Network, Pencil, Plus, Trash2 } from '../components/ui/icons';
import { useI18n } from '../i18n';
import { Page, PageBody, PageBreadcrumb, PageTopbar } from '../components/layout/page';
import { SettingsBlock, SettingsRow, SettingsSection } from '../components/layout/settings';
import { MachinePill } from '../components/identity/Identity';
import { PoolDialog } from '../components/pools/PoolDialog';
import { PoolLimitsLine, useWhenFull } from '../components/pools/PoolHealth';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { toast } from '../components/ui/toast';
import { poolsView, type AppView } from '../navigation';
import { POOL_WEIGHT_LABEL, newPool, removePool, savePool, usePools } from '../services/pools';
import type { MachinePool } from '../native/types';

/**
 * Settings › Pools: named sets of machines that harness runs are balanced across, with each one's machines, weights and
 * limits. How each pool stands now is on Fleet › Pools.
 */
export function PoolsSettingsPage({ onNavigate }: { onNavigate: (view: AppView) => void }) {
  const { t } = useI18n();
  const { pools, error } = usePools();
  // The pool being edited ('' id for a new one), while the dialog is open.
  const [editing, setEditing] = useState<MachinePool | null>(null);
  return (
    <Page>
      <PageTopbar>
        <PageBreadcrumb segments={[t('settings.title'), t('settings.nav.pools')]} />
      </PageTopbar>
      <PageBody gap="gap-6">
        {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
        <SettingsSection settingId="pools.list" title={t('pools.list.title')} description={t('pools.list.description')}>
          <SettingsRow
            title={t('pools.list.rowTitle')}
            description={t('pools.list.rowDescription')}
            control={<Button variant="outline" size="sm" onClick={() => setEditing(newPool())} disabled={!pools}><Plus />{t('pools.new')}</Button>}
          />
        </SettingsSection>
        {!pools ? (
          error ? null : <p className="flex items-center gap-2 px-4 text-sm text-muted-foreground" role="status"><Spinner />{t('pools.loading')}</p>
        ) : pools.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground" data-slot="pools-empty">{t('pools.empty')}</p>
        ) : (
          pools.map((pool) => (
            <PoolSection
              key={pool.id}
              pool={pool}
              pools={pools}
              onEdit={() => setEditing(pool)}
              onOpen={() => onNavigate(poolsView(pool.id))}
            />
          ))
        )}
        <PoolDialog pool={editing} pools={pools ?? []} onClose={() => setEditing(null)} />
      </PageBody>
    </Page>
  );
}

/**
 * One pool's configuration: its machines and their weights, the limits that make a machine full, and what a run does
 * then. How it stands now, and its runs, are on its Fleet › Pools page.
 */
function PoolSection({ pool, pools, onEdit, onOpen }: {
  pool: MachinePool;
  pools: MachinePool[];
  onEdit: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [removing, setRemoving] = useState(false);
  const whenFull = useWhenFull(pool, pools);
  const remove = async () => {
    setRemoving(true);
    try {
      const unhooked = pools.filter((other) => other.spillPool === pool.id).length;
      await removePool(pool.id);
      toast({
        kind: 'success',
        title: t('pools.removed', { name: pool.name }),
        description: unhooked ? t(unhooked === 1 ? 'pools.removedUnhooked.one' : 'pools.removedUnhooked.other', { count: unhooked }) : undefined,
        action: { label: t('common.undo'), onClick: () => { savePool(pool).catch((failure: unknown) => toast({ kind: 'error', title: String(failure) })); } },
        focusAction: true,
      });
    } catch (failure) {
      toast({ kind: 'error', title: String(failure) });
      setRemoving(false);
    }
  };
  return (
    <SettingsSection
      settingId={`pools.pool.${pool.id}`}
      title={pool.name}
      headerAction={
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOpen}><Network />{t('pools.settings.open')}</Button>
          <Button variant="outline" size="sm" onClick={onEdit}><Pencil />{t('pools.edit')}</Button>
          <Button variant="ghost" size="icon-sm" onClick={() => void remove()} disabled={removing} aria-label={t('pools.remove', { name: pool.name })} title={t('pools.remove', { name: pool.name })}>
            <Trash2 />
          </Button>
        </div>
      }
    >
      <SettingsBlock className="flex flex-col gap-2 py-3 text-sm">
        {pool.members.length === 0 ? (
          <span className="text-muted-foreground">{t('pools.noMembers')}</span>
        ) : (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {pool.members.map((member) => (
              <li key={member.machine} className="inline-flex items-center gap-1.5">
                <MachinePill name={member.machine} />
                <span className="text-xs text-muted-foreground">{t(POOL_WEIGHT_LABEL[member.weight])}</span>
              </li>
            ))}
          </ul>
        )}
        <PoolLimitsLine pool={pool} />
        <p className="text-xs text-muted-foreground">{t('pools.page.whenFull', { action: whenFull })}</p>
      </SettingsBlock>
    </SettingsSection>
  );
}

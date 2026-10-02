import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { usePools } from '../services/pools';
import { Network } from './ui/icons';

/** A pool named where something runs on it, read from the saved pools; says so when it's been removed. */
export function PoolName({ id, className }: { id: string; className?: string }) {
  const { t } = useI18n();
  const { pools } = usePools();
  const name = pools?.find((pool) => pool.id === id)?.name;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap', !name && 'text-muted-foreground', className)}>
      <Network className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{name ?? (pools ? t('pools.target.removed') : '…')}</span>
    </span>
  );
}

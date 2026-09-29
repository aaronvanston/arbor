import { ArrowUpRight, Import, Plus, PowerOff, TriangleAlert } from './ui/icons';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { accountLimitsView, type AppView } from '../navigation';
import { addAccount } from '../services/addAccount';
import type { AccountsGap } from '../services/accountsStore';
import { Button } from './ui/button';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from './ui/empty';
import { RefreshIcon } from './ui/refresh-icon';

/**
 * What a list of account limits shows with no account on to show. Add account only when the core has none at all,
 * and Import where the page can take a file; when every account is off, the way to turn one back on (Accounts lists
 * every one, off or on); when the list didn't load, why, and Try again.
 */
export function AccountsEmpty({ gap, icon, description, error, retrying = false, onRetry, onNavigate, onAddAccount, onImport }: {
  gap: Exclude<AccountsGap, 'loading'>;
  /** Shown when there are no accounts. */
  icon: ReactNode;
  /** What adding an account brings here. */
  description: string;
  /** Why the list didn't load, where the page doesn't already say. */
  error?: string;
  retrying?: boolean;
  onRetry: () => void;
  onNavigate?: (view: AppView) => void;
  /** Adds an account in place, on the page that does; elsewhere Add account opens Accounts › Sign-ins. */
  onAddAccount?: () => void;
  /** Imports authentication files, where the page offers it. */
  onImport?: () => void;
}) {
  const { t } = useI18n();
  const add = onAddAccount ?? (onNavigate ? () => addAccount(onNavigate) : undefined);
  if (gap === 'failed') {
    return (
      <Empty size="sm">
        <EmptyMedia><TriangleAlert /></EmptyMedia>
        <div>
          <EmptyTitle>{t('accounts.failed.title')}</EmptyTitle>
          {error ? <EmptyDescription>{error}</EmptyDescription> : null}
        </div>
        <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
          <RefreshIcon refreshing={retrying} />
          {t('accounts.failed.retry')}
        </Button>
      </Empty>
    );
  }
  if (gap === 'off') {
    return (
      <Empty size="sm">
        <EmptyMedia><PowerOff /></EmptyMedia>
        <div>
          <EmptyTitle>{t('accounts.off.title')}</EmptyTitle>
          <EmptyDescription>{t('accounts.off.description')}</EmptyDescription>
        </div>
        {onNavigate ? (
          <Button variant="outline" size="sm" onClick={() => onNavigate(accountLimitsView())}>
            {t('accounts.off.open')}
            <ArrowUpRight />
          </Button>
        ) : null}
      </Empty>
    );
  }
  return (
    <Empty size="sm">
      <EmptyMedia>{icon}</EmptyMedia>
      <div>
        <EmptyTitle>{t('accounts.empty.title')}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </div>
      <div className="flex items-center gap-2">
        {add ? (
          <Button size="sm" onClick={add}>
            <Plus />
            {t('accounts.add')}
          </Button>
        ) : null}
        {onImport ? (
          <Button variant="outline" size="sm" onClick={onImport}>
            <Import />
            {t('authFiles.import')}
          </Button>
        ) : null}
      </div>
    </Empty>
  );
}

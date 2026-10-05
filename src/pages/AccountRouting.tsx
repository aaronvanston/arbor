import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check } from '../components/ui/icons';
import { AccountAvatar } from '../components/AccountAvatar';
import { SettingsBlock, SettingsSection } from '../components/layout/settings';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { Switch } from '../components/ui/switch';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../components/ui/tooltip';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { useAccountLimitPrefs } from '../services/accountLimits';
import { useAccountOrder } from '../services/accountOrder';
import { resolveAccountProfile, useAccountProfiles } from '../services/accountProfiles';
import { accountFilesFromListing, loadAccountFiles, refreshAccountQuotas, useAccountsStore } from '../services/accountsStore';
import { formatResetCountdown, providerLabel } from '../services/providerLimits';
import { getQuotaCacheSnapshot, useQuotaCache } from '../services/quotaCache';
import {
  applyRoutingPlan,
  providerRoutingPlans,
  setRoutingAuto,
  useRoutingAuto,
  type ProviderRouting,
  type RoutingItem,
} from '../services/quotaRouting';
import { quotaKey, type AuthFile } from '../services/quotaService';
import { useQuotaClock } from '../services/quotaTime';
import { ProviderMark } from '../components/identity/Identity';


const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * Settings › Routing's account order: the accounts as the Accounts page lists them, read fresh for their priorities,
 * and the limits of any never read, which the suggestions go by.
 */
export function AccountOrderSection() {
  const { files } = useAccountsStore();
  const coreReady = Boolean(useCoreRuntime().status?.ready);
  const [error, setError] = useState('');
  useEffect(() => {
    void loadAccountFiles().then((listed) => {
      const quotas = getQuotaCacheSnapshot();
      void refreshAccountQuotas(listed.filter((file) => (quotas[quotaKey(file)]?.status ?? 'idle') === 'idle'));
    });
  }, []);
  return (
    <>
      {error ? <Alert variant="error" icon={<AlertCircle />}><AlertDescription>{error}</AlertDescription></Alert> : null}
      <AccountRouting files={files} onError={setError} coreReady={coreReady} />
    </>
  );
}

/**
 * Suggested credential priorities for each provider, from the limits the Accounts page reads, with a
 * button to apply them and a switch to keep them applied. Nothing shows until a provider has accounts
 * to order.
 */
export function AccountRouting({ files, onError, coreReady = true }: {
  /** The core's whole listing; only the accounts in use are ordered. */
  files: AuthFile[];
  onError: (message: string) => void;
  /** Priorities are the running core's, so there's nothing to apply them to while it's stopped. */
  coreReady?: boolean;
}) {
  const { t } = useI18n();
  const quotas = useQuotaCache();
  const profiles = useAccountProfiles();
  const prefs = useAccountLimitPrefs();
  const order = useAccountOrder();
  const routings = useMemo(
    () => providerRoutingPlans(accountFilesFromListing(files), quotas, profiles, prefs, Date.now(), order),
    [files, quotas, profiles, prefs, order],
  );
  if (!routings.length) return null;
  return (
    <SettingsSection settingId="routing.accounts" title={t('accounts.routing.title')} description={t('accounts.routing.description')}>
      {routings.map((routing) => <ProviderRoutingBlock key={routing.provider} routing={routing} onError={onError} coreReady={coreReady} />)}
    </SettingsSection>
  );
}

function ProviderRoutingBlock({ routing: { provider, window, plan }, onError, coreReady }: { routing: ProviderRouting; onError: (message: string) => void; coreReady: boolean }) {
  const { t } = useI18n();
  const now = useQuotaClock();
  const profiles = useAccountProfiles();
  const auto = useRoutingAuto()[provider] ?? false;
  const [applying, setApplying] = useState(false);
  const label = providerLabel[provider];
  const apply = async () => {
    setApplying(true);
    onError('');
    try {
      await applyRoutingPlan(plan.changes);
    } catch (applyError) {
      onError(t('accounts.routing.failed', { error: applyError instanceof Error ? applyError.message : String(applyError) }));
    } finally {
      setApplying(false);
      // The Accounts page and automatic routing read the priorities from here.
      void loadAccountFiles();
    }
  };
  const reasonText = (item: RoutingItem) => {
    const { reason } = item;
    if (reason.kind === 'soonest') return t('accounts.routing.reason.soonest', { percent: Math.round(reason.percent), time: formatResetCountdown(reason.resetAtMs, now) || '—' });
    if (reason.kind === 'low') return t('accounts.routing.reason.low', { percent: Math.round(reason.percent) });
    return t(`accounts.routing.reason.${reason.kind}`);
  };
  return (
    <SettingsBlock className="flex flex-col gap-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="inline-flex min-w-0 items-center gap-2 text-xs">
          <ProviderMark provider={provider} decorative className="size-4" />
          <strong className="text-sm font-medium text-foreground">{label}</strong>
          <span aria-hidden="true" className="text-muted-foreground/50">·</span>
          <span className="truncate text-muted-foreground">{t('accounts.routing.window', { window: lowerFirst(window) })}</span>
        </span>
        <div className="flex shrink-0 items-center gap-3">
          <Tooltip>
            <TooltipTrigger render={<label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" />}>
              <Switch size="sm" checked={auto} onCheckedChange={(checked) => setRoutingAuto(provider, checked)} aria-label={t('accounts.routing.autoAria', { provider: label })} />
              {t('accounts.routing.auto')}
            </TooltipTrigger>
            <TooltipPopup>{t('accounts.routing.autoHint')}</TooltipPopup>
          </Tooltip>
          {plan.changes.length ? (
            <Button variant="outline" size="xs" onClick={() => void apply()} disabled={applying || !coreReady} disabledReason={coreReady ? undefined : t('accounts.routing.coreStopped')} aria-label={t('accounts.routing.applyAria', { provider: label })}>
              {applying ? <Spinner className="size-3" /> : null}
              {t('accounts.routing.apply')}
            </Button>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden="true" />
              {t('accounts.routing.matches')}
            </span>
          )}
        </div>
      </div>
      <ol className="flex flex-col gap-1.5 text-xs">
        {plan.items.map((item, index) => {
          const changing = item.suggested !== null && item.suggested !== item.current;
          return (
            <li key={item.key} className="grid grid-cols-[1rem_auto_minmax(0,1fr)_auto] items-center gap-2">
              <span className="tabular-nums text-muted-foreground">{item.suggested === null ? '·' : index + 1}</span>
              <AccountAvatar profile={resolveAccountProfile(item.key, item.fileName, profiles[item.key])} size="xs" />
              <span className="min-w-0 truncate">
                <span className="font-medium text-foreground" title={item.fileName}>{item.name}</span>
                <span className="text-muted-foreground"> · {reasonText(item)}</span>
              </span>
              <span className={cn('tabular-nums', changing ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                {changing
                  ? t('accounts.routing.change', { from: item.current, to: item.suggested! })
                  : t('accounts.routing.priority', { priority: item.current })}
              </span>
            </li>
          );
        })}
      </ol>
    </SettingsBlock>
  );
}

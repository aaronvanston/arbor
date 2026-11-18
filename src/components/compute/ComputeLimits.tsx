import { useI18n } from '../../i18n';
import { formatDate, formatDuration, formatMoney, formatNumber, formatWhen } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { ComputeLimit, ComputeProviderSnapshot } from '../../native/types';
import {
  findLimit,
  LIMIT_LABEL,
  limitShare,
  limitTone,
  METER_LIMITS,
  planHoursGoneLastSaid,
  START_BLOCK_LABEL,
  type ComputeTone,
} from '../../services/compute';
import { computeProviderName } from '../../services/computeHint';
import { SettingsSection } from '../layout/settings';
import { Badge } from '../ui/badge';
import { Check, TriangleAlert } from '../ui/icons';
import { Meter } from '../ui/meter';
import { ComputeProviderMark } from './ComputeProviderMark';

/** A countdown under an hour away reads "Resets in 8m"; anything further off says when. */
const SOON_MS = 3_600_000;

function LimitCell({ limit, nowMs, billed }: {
  limit: ComputeLimit;
  nowMs: number;
  /** Past this limit sandboxes still run, as extra spend: used up is a warning here, not a stop. */
  billed: boolean;
}) {
  const { t } = useI18n();
  const full = limitTone(limit);
  const tone: ComputeTone = billed && full === 'error' ? 'warning' : full;
  const share = limitShare(limit);
  const money = limit.kind === 'extraSpend';
  const used = money ? formatMoney(limit.used) : formatNumber(limit.used);
  const max = limit.max === null ? null : money ? formatMoney(limit.max) : formatNumber(limit.max);
  const valueText = max === null
    ? t('compute.page.limits.noMax', { used })
    : limit.kind === 'planHours' ? t('compute.page.limits.used', { used, max }) : t('compute.hoursOf', { used, max });
  const reset = limit.resetsAtMs === null
    ? limit.kind === 'activeSandboxes' ? t('compute.page.limits.counted') : null
    : limit.resetsAtMs - nowMs < SOON_MS
      ? t('compute.limit.resetsIn', { span: formatDuration(limit.resetsAtMs - nowMs, 'up') })
      : t('compute.limit.resets', { when: limit.resetsAtMs - nowMs < 86_400_000 ? formatWhen(limit.resetsAtMs, { now: nowMs }) : formatDate(limit.resetsAtMs, { now: nowMs }) });
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-3" data-limit={limit.kind}>
      <span className="truncate text-xs text-muted-foreground">{t(LIMIT_LABEL[limit.kind])}</span>
      <span className={cn('truncate text-sm tabular-nums', tone === 'error' ? 'text-destructive-foreground' : tone === 'warning' ? 'text-warning-foreground' : 'text-foreground')}>
        {valueText}
      </span>
      <Meter value={share === null ? null : share * 100} tone={tone === 'primary' ? 'muted' : tone} animated={false} />
      <span className="h-4 truncate text-2xs text-muted-foreground">{reset}</span>
    </div>
  );
}

/** One provider's limits: whether a sandbox can start now (and why not), the key it reads with, and each limit as a meter. */
function ProviderLimits({ provider, nowMs, stale }: { provider: ComputeProviderSnapshot; nowMs: number; stale: boolean }) {
  const { t } = useI18n();
  const name = computeProviderName(provider.id);
  const limits = [...METER_LIMITS, 'planHours' as const].map((kind) => findLimit(provider, kind)).filter((limit) => limit !== undefined);
  const hoursBilled = planHoursGoneLastSaid(provider) === 'billed';
  return (
    <div className="@container flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium"><ComputeProviderMark provider={provider.id} />{name}</span>
        <span className="ms-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/* Whether a sandbox can start is only as good as the read: an earlier read's isn't said as if it were now's. */}
          {provider.canStart === true && !stale ? <Badge variant="success"><Check aria-hidden="true" />{t('compute.canStart')}</Badge> : null}
          {provider.canStart === false && !stale ? (
            <Badge variant="error"><TriangleAlert aria-hidden="true" />{t('compute.startsBlocked', { reason: t(START_BLOCK_LABEL[provider.startBlock ?? 'other']) })}</Badge>
          ) : null}
          {provider.keyAccess === 'readOnly' ? <Badge variant="muted">{t('compute.readOnlyKey')}</Badge> : null}
          {provider.keyAccess === 'canWrite' ? <span className="text-warning-foreground">{t('compute.canWriteKey', { provider: name })}</span> : null}
          {provider.keyExpiresAtMs !== null ? <span>{t('compute.page.limits.keyExpires', { when: formatDate(provider.keyExpiresAtMs, { now: nowMs }) })}</span> : null}
        </span>
      </div>
      {limits.length ? (
        <div className="overflow-hidden border-t border-border/50">
          <div className="-mt-px -ml-px grid grid-cols-1 *:border-t *:border-l *:border-border/50 @xs:grid-cols-2 @min-[44rem]:grid-cols-5">
            {limits.map((limit) => <LimitCell key={limit.kind} limit={limit} nowMs={nowMs} billed={limit.kind === 'planHours' && hoursBilled} />)}
          </div>
        </div>
      ) : (
        <p className="border-t border-border/50 px-4 py-3 text-xs text-muted-foreground">
          {provider.status === 'limitsNeedScope' ? t('compute.page.limitsNeedScope', { provider: name }) : t('compute.page.limits.none', { provider: name })}
        </p>
      )}
    </div>
  );
}

/** Fleet › Compute's Limits card: each provider shown, its standing for new sandboxes and its limits. */
export function ComputeLimits({ providers, nowMs, stale }: { providers: readonly ComputeProviderSnapshot[]; nowMs: number; stale: boolean }) {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('compute.page.limits.title')} description={t('compute.page.limits.about')} contentClassName={cn(stale && 'opacity-60')}>
      {providers.map((provider) => <ProviderLimits key={provider.id} provider={provider} nowMs={nowMs} stale={stale} />)}
    </SettingsSection>
  );
}

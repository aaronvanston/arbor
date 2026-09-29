import { invokeCommand } from '../native/commands';
import { ExternalLink, TriangleAlert, Wrench, X } from './ui/icons';
import { useI18n } from '../i18n';
import { useAppPreferences } from '../appPreferences';
import { providerLabel } from '../services/providerLimits';
import {
  activeStatus,
  affectedComponents,
  dismissProviderStatus,
  isOutage,
  statusIncidents,
  statusPageUrl,
  statusSignature,
  useDismissedStatuses,
  useProviderStatuses,
  type ProviderStatus,
  type StatusIncident,
  type StatusProvider,
} from '../services/providerStatus';
import { incidentStatusKey } from '../services/providerStatusText';
import { formatAgo } from '../lib/format';
import { useQuotaClock } from '../services/quotaTime';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Button } from './ui/button';

const INCIDENTS_SHOWN = 2;

/**
 * A banner for providers whose status page reports trouble with what Arbor uses. Closing it lasts until the
 * problem changes or gets worse.
 */
export function ProviderStatusBanner() {
  const preferences = useAppPreferences();
  const statuses = useProviderStatuses();
  const dismissed = useDismissedStatuses();
  const now = useQuotaClock();
  if (!preferences.providerStatus) return null;
  const shown = (['claude', 'codex'] as const).flatMap((provider) => {
    const status = activeStatus(statuses[provider], now);
    return status && dismissed[provider] !== statusSignature(status) ? [{ provider, status }] : [];
  });
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="provider-status">
      {shown.map(({ provider, status }) => <ProviderStatusAlert key={provider} provider={provider} status={status} now={now} />)}
    </div>
  );
}

function ProviderStatusAlert({ provider, status, now }: { provider: StatusProvider; status: ProviderStatus; now: number }) {
  const { t } = useI18n();
  const incidents = statusIncidents(status);
  const components = affectedComponents(status);
  const lead = incidents[0];
  const open = (url: string) => {
    invokeCommand('open_external_url', { url }).catch((error) => console.warn('Failed to open the status page', error));
  };
  const incidentLine = (incident: StatusIncident) => {
    const updatedMs = incident.updatedAt ? Date.parse(incident.updatedAt) : NaN;
    const statusKey = incidentStatusKey[incident.status];
    return [
      incident.name,
      statusKey ? t(statusKey) : '',
      Number.isFinite(updatedMs) ? t('status.banner.updated', { time: formatAgo(updatedMs, now) }) : '',
    ].filter(Boolean).join(' · ');
  };
  const variant = isOutage(status.indicator) ? 'error' : status.indicator === 'maintenance' ? 'info' : 'warning';
  return (
    <Alert
      variant={variant}
      icon={status.indicator === 'maintenance' ? <Wrench /> : <TriangleAlert />}
      action={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="xs" onClick={() => open(lead?.url ?? statusPageUrl[provider])}>
            {t(!lead ? 'status.banner.openPage' : lead.indicator === 'maintenance' ? 'status.banner.openMaintenance' : 'status.banner.openIncident')}
            <ExternalLink />
          </Button>
          <Button variant="ghost-muted" size="icon-xs" aria-label={t('status.banner.dismiss')} onClick={() => dismissProviderStatus(provider, status)}>
            <X />
          </Button>
        </div>
      }
    >
      <AlertTitle>{t('status.banner.title', { provider: providerLabel[provider], state: t(`status.indicator.${status.indicator}`) })}</AlertTitle>
      <AlertDescription className="gap-0.5">
        {incidents.slice(0, INCIDENTS_SHOWN).map((incident) => <span key={incident.id || incident.name}>{incidentLine(incident)}</span>)}
        {incidents.length > INCIDENTS_SHOWN ? (
          <span>{t(incidents.length - INCIDENTS_SHOWN === 1 ? 'status.banner.more.one' : 'status.banner.more.other', { count: incidents.length - INCIDENTS_SHOWN })}</span>
        ) : null}
        {components.length ? (
          <span>
            {t('status.banner.affects', {
              components: components.map((component) => `${component.name} (${t(`status.indicator.${component.indicator}`).toLowerCase()})`).join(', '),
            })}
          </span>
        ) : null}
        {status.error ? <span>{t('status.banner.stale', { time: formatAgo(status.checkedAt, now) })}</span> : null}
      </AlertDescription>
    </Alert>
  );
}

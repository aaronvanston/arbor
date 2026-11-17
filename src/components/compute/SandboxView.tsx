import { useState } from 'react';
import { requestFocus } from '../../focusRequests';
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard';
import { useI18n } from '../../i18n';
import { formatDuration, formatNumber, formatWhen } from '../../lib/format';
import { cn } from '../../lib/utils';
import { machinesView, sessionsView, type AppView } from '../../navigation';
import type { ComputePoint, ComputeProviderId, ComputeSandbox } from '../../native/types';
import { readCommandError } from '../../services/commandError';
import {
  cpuTone,
  formatEndedAgo,
  formatHours,
  formatSandboxAge,
  formatStopsIn,
  loadUnreadLabel,
  memoryTone,
  openComputeSandbox,
  percentOf,
  sandboxAgeMs,
  sandboxCpu,
  sandboxFlags,
  sandboxMemory,
  shortComputeSessionId,
  stopsSoon,
  unlinkComputeSandbox,
} from '../../services/compute';
import { computeProviderName } from '../../services/computeHint';
import { ISSUE_LABEL } from '../../services/computeAlerts';
import { cpuAtLimitForMs, relinkComputeSandbox } from '../../services/computePage';
import { HarnessName } from '../identity/Harness';
import { MachinePill } from '../identity/Identity';
import { DetailRow, SettingsSection } from '../layout/settings';
import { StatBlock, StatsGrid } from '../layout/stats';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AlertCircle, Check, ChevronRight, Copy, ExternalLink, TriangleAlert } from '../ui/icons';
import { toast } from '../ui/toast';
import { LoadChart, useSandboxHistory } from './LoadChart';
import { ProviderMark, SandboxDot, SandboxFlags } from './parts';

type Navigate = (view: AppView) => void;

/** Opens the sandbox on its provider's own site; a failure says so in a toast, as there's nowhere inline for it. */
export function useOpenInProvider() {
  return (provider: ComputeProviderId, sandboxId: string) =>
    void openComputeSandbox(provider, sandboxId).catch((failure: unknown) => toast({ title: readCommandError(failure).message, kind: 'error' }));
}

/** The name, its state and size, and the two things to do with it: copy its id, open it at the provider. */
function SandboxHeader({ provider, sandbox }: { provider: ComputeProviderId; sandbox: ComputeSandbox }) {
  const { t } = useI18n();
  const { copy, copied } = useCopyToClipboard();
  const open = useOpenInProvider();
  const meta = [
    t(`compute.state.${sandbox.state}`),
    t('compute.sizeLine', { vcpus: sandbox.vcpus, memory: formatNumber(sandbox.memoryGb) }),
    sandbox.multiplier === null ? null : t('compute.sandbox.multiplierShort', { multiplier: formatNumber(sandbox.multiplier, 1) }),
  ].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SandboxDot sandbox={sandbox} />
          <h1 className="truncate text-lg font-semibold text-foreground">{sandbox.name}</h1>
          <Badge variant="outline">{sandbox.size}</Badge>
          <SandboxFlags sandbox={sandbox} />
        </div>
        <p className="text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy(sandbox.id, { label: t('compute.copiedId', { id: sandbox.id }) })}>
          {copied === sandbox.id ? <Check /> : <Copy />}{t('compute.copyId')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => open(provider, sandbox.id)}>
          {t('compute.openIn', { provider: computeProviderName(provider) })}<ExternalLink />
        </Button>
      </div>
    </div>
  );
}

const TEXT_TONE = { error: 'text-destructive-foreground', warning: 'text-warning-foreground', primary: '', muted: '' } as const;

function SandboxStats({ provider, sandbox, nowMs }: { provider: ComputeProviderId; sandbox: ComputeSandbox; nowMs: number }) {
  const { t } = useI18n();
  const cpu = sandboxCpu(sandbox);
  const memory = sandboxMemory(sandbox);
  const unreadLabel = loadUnreadLabel(sandbox);
  const unread = unreadLabel ? t(unreadLabel) : null;
  const percent = (share: number | null, tone: keyof typeof TEXT_TONE) => (share === null ? '—' : (
    <span className={TEXT_TONE[tone]}>{percentOf(share)}<span className="ms-0.5 text-xs font-normal text-muted-foreground">%</span></span>
  ));
  const stopsIn = formatStopsIn(sandbox, nowMs);
  const age = formatSandboxAge(sandbox, nowMs);
  return (
    <StatsGrid columns={4}>
      <StatBlock
        label={t('compute.sandbox.cpu')}
        value={percent(cpu, cpuTone(sandbox))}
        hint={cpu === null ? unread : t('compute.sandbox.cpuBusy', { busy: formatNumber(cpu * sandbox.vcpus, 1), vcpus: sandbox.vcpus })}
      />
      <StatBlock
        label={t('compute.sandbox.memory')}
        value={percent(memory, memoryTone(sandbox))}
        hint={memory === null ? unread : t('compute.sandbox.memoryUsed', { used: formatNumber(memory * sandbox.memoryGb, 1), total: formatNumber(sandbox.memoryGb) })}
      />
      <StatBlock
        label={t('compute.sandbox.stopsIn')}
        tone={stopsIn !== null && stopsSoon(sandbox, nowMs) ? 'warning' : 'default'}
        value={stopsIn ?? t('compute.noAutoStop')}
        hint={sandbox.stopsAtMs === null ? t('compute.sandbox.noAutoStop', { age }) : t('compute.sandbox.stopsAt', { when: formatWhen(sandbox.stopsAtMs, { now: nowMs }), age })}
      />
      <StatBlock
        label={t('compute.sandbox.monthHours')}
        value={sandbox.monthHours === null ? '—' : t('compute.hours', { hours: formatHours(sandbox.monthHours) })}
        hint={sandbox.multiplier === null
          ? sandbox.monthHours === null ? t('compute.sandbox.noHours', { provider: computeProviderName(provider) }) : undefined
          : t(sandbox.multiplier === 1 ? 'compute.sandbox.multiplier.one' : 'compute.sandbox.multiplier.other', { multiplier: formatNumber(sandbox.multiplier, 1) })}
      />
    </StatsGrid>
  );
}

/** What wants a look, above the chart: in error, at its CPU limit for a while, looks forgotten, degraded. */
function SandboxBanners({ provider, sandbox, points, nowMs }: { provider: ComputeProviderId; sandbox: ComputeSandbox; points: ComputePoint[]; nowMs: number }) {
  const { t } = useI18n();
  const flags = sandboxFlags(sandbox);
  const banners: { key: string; variant: 'error' | 'warning'; text: string }[] = [];
  if (flags.includes('error')) banners.push({ key: 'error', variant: 'error', text: t('compute.sandbox.inError', { provider: computeProviderName(provider) }) });
  if (flags.includes('cpuAtLimit')) {
    const forMs = cpuAtLimitForMs(points);
    banners.push({ key: 'cpu', variant: 'warning', text: forMs ? t('compute.sandbox.cpuAtLimitFor', { duration: formatDuration(forMs) }) : t('compute.sandbox.cpuAtLimit') });
  }
  if (flags.includes('forgotten') && sandbox.forgotten) {
    const age = formatDuration(sandboxAgeMs(sandbox, nowMs));
    const ended = sandbox.session?.endedAtMs;
    banners.push({
      key: 'forgotten',
      variant: 'warning',
      text: sandbox.forgotten !== 'sessionEnded' ? t(`compute.sandbox.forgotten.${sandbox.forgotten}`, { age })
        // One with an auto-stop due stops by itself; it only uses plan hours until then.
        : sandbox.stopsAtMs !== null
          ? t('compute.sandbox.forgotten.sessionEndedStops', { ago: ended ? formatEndedAgo(ended, nowMs) : '—', when: formatWhen(sandbox.stopsAtMs, { now: nowMs }) })
          : t('compute.sandbox.forgotten.sessionEnded', { ago: ended ? formatEndedAgo(ended, nowMs) : '—' }),
    });
  }
  if (flags.includes('degraded') && sandbox.issue) {
    banners.push({
      key: 'degraded',
      variant: 'warning',
      text: t('compute.sandbox.degradedFor', { issue: t(ISSUE_LABEL[sandbox.issue]), duration: formatDuration(sandbox.issueSinceMs === null ? 0 : nowMs - sandbox.issueSinceMs) }),
    });
  }
  return (
    <>
      {banners.map((banner) => (
        <Alert key={banner.key} variant={banner.variant} icon={banner.variant === 'error' ? <AlertCircle /> : <TriangleAlert />}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ))}
    </>
  );
}

/** A link inside a details row: "Open ›". */
function OpenLink({ onClick, label }: { onClick: () => void; label: string }) {
  const { t } = useI18n();
  return (
    <Button variant="ghost-muted" size="xs" onClick={onClick} aria-label={label}>
      {t('compute.sandbox.open')}<ChevronRight />
    </Button>
  );
}

/**
 * The machine and session that started it, as Arbor linked them by id, and whose it is. A sandbox linked from the
 * command line can be unlinked here, with Undo putting the same link back; one its provider's labels link can't be,
 * since only the provider can change those.
 */
function StartedBy({ provider, sandbox, nowMs, onNavigate }: { provider: ComputeProviderId; sandbox: ComputeSandbox; nowMs: number; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const session = sandbox.session;
  const machine = sandbox.machine;
  const howToLink = () => {
    requestFocus('setting', 'compute.linking');
    onNavigate({ kind: 'settings', page: 'compute' });
  };
  const unlink = async () => {
    if (!machine) return;
    setBusy(true);
    try {
      await unlinkComputeSandbox(provider, sandbox.id);
      toast({
        kind: 'success',
        title: t('compute.sandbox.unlinked', { name: sandbox.name }),
        focusAction: true,
        action: {
          label: t('common.undo'),
          onClick: () => void relinkComputeSandbox(provider, sandbox.id, machine, session?.id ?? null)
            .catch((failure: unknown) => toast({ kind: 'error', title: t('compute.sandbox.relinkFailed', { name: sandbox.name, error: readCommandError(failure).message }) })),
        },
      });
    } catch (failure) {
      toast({ kind: 'error', title: t('compute.sandbox.unlinkFailed', { name: sandbox.name, error: readCommandError(failure).message }) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title={t('compute.sandbox.startedBy')}
      headerAction={sandbox.mine && machine && sandbox.linkedBy === 'link' ? <Button variant="ghost-muted" size="sm" disabled={busy} onClick={() => void unlink()}>{t('compute.sandbox.unlink')}</Button> : null}
    >
      {sandbox.mine ? (
        <>
          <DetailRow
            label={t('compute.sandbox.machine')}
            value={machine ? (
              <span className="flex items-center justify-end gap-2">
                <MachinePill name={machine} />
                <OpenLink label={machine} onClick={() => onNavigate(machinesView(machine))} />
              </span>
            ) : (
              <span className="flex items-center justify-end gap-2 text-muted-foreground">
                {t(sandbox.linkProblem === 'unknownMachine' ? 'compute.linkProblem.unknownMachine' : 'compute.notLinked')}
                <Button variant="ghost-muted" size="xs" onClick={howToLink}>{t('compute.page.howToLink')}</Button>
              </span>
            )}
          />
          {session ? (
            <DetailRow
              label={t('compute.sandbox.session')}
              value={(
                <span className="flex items-center justify-end gap-2">
                  <span className="font-mono text-xs">{shortComputeSessionId(session.id)}</span>
                  {session.known ? (
                    <>
                      {session.harness ? <HarnessName harness={session.harness} /> : null}
                      {session.live
                        ? <span className="text-success-foreground">{t('compute.live')}</span>
                        : session.endedAtMs !== null ? <span className="text-muted-foreground">{t('compute.endedAgo', { ago: formatEndedAgo(session.endedAtMs, nowMs) })}</span> : null}
                      <OpenLink label={shortComputeSessionId(session.id)} onClick={() => onNavigate(sessionsView({ session: session.id }))} />
                    </>
                  ) : <span className="text-muted-foreground">{t('compute.sessionUnknown')}</span>}
                </span>
              )}
            />
          ) : null}
        </>
      ) : null}
      <DetailRow label={t('compute.sandbox.owner')} value={t(sandbox.mine ? 'compute.you' : 'compute.aTeammate')} />
    </SettingsSection>
  );
}

function SandboxDetails({ provider, sandbox, nowMs }: { provider: ComputeProviderId; sandbox: ComputeSandbox; nowMs: number }) {
  const { t } = useI18n();
  const health = sandbox.state === 'error'
    ? t('compute.state.error')
    : sandbox.issue
      ? t('compute.sandbox.degradedFor', { issue: t(ISSUE_LABEL[sandbox.issue]), duration: formatDuration(sandbox.issueSinceMs === null ? 0 : nowMs - sandbox.issueSinceMs) })
      : t('compute.sandbox.healthy');
  return (
    <SettingsSection title={t('compute.sandbox.details')}>
      <DetailRow label={t('compute.sandbox.provider')} value={<span className="flex items-center justify-end gap-2"><ProviderMark provider={provider} />{computeProviderName(provider)}</span>} />
      <DetailRow
        label={t('compute.sandbox.size')}
        value={<span>{sandbox.size} <span className="text-muted-foreground">{t('compute.sizeLine', { vcpus: sandbox.vcpus, memory: formatNumber(sandbox.memoryGb) })}</span></span>}
      />
      {sandbox.multiplier === null ? null : <DetailRow label={t('compute.sandbox.multiplierRow')} value={`${formatNumber(sandbox.multiplier, 1)}×`} />}
      <DetailRow label={t('compute.sandbox.health')} value={<span className={cn((sandbox.state === 'error' || sandbox.issue) && 'text-warning-foreground')}>{health}</span>} />
      <DetailRow label={t('compute.sandbox.id')} value={sandbox.id} mono />
    </SettingsSection>
  );
}

/** One sandbox's own page, under the breadcrumb ComputePage draws. */
export function SandboxView({ provider, sandbox, nowMs, onNavigate }: { provider: ComputeProviderId; sandbox: ComputeSandbox; nowMs: number; onNavigate: Navigate }) {
  const { t } = useI18n();
  const points = useSandboxHistory(provider, sandbox);
  return (
    <>
      <SandboxHeader provider={provider} sandbox={sandbox} />
      <SandboxStats provider={provider} sandbox={sandbox} nowMs={nowMs} />
      <SandboxBanners provider={provider} sandbox={sandbox} points={points} nowMs={nowMs} />
      <SettingsSection
        title={t('compute.sandbox.load.title')}
        summary={t('compute.sandbox.load.about')}
      >
        <LoadChart sandbox={sandbox} points={points} />
      </SettingsSection>
      <StartedBy provider={provider} sandbox={sandbox} nowMs={nowMs} onNavigate={onNavigate} />
      <SandboxDetails provider={provider} sandbox={sandbox} nowMs={nowMs} />
    </>
  );
}

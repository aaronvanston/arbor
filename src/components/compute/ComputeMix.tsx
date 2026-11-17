import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { formatNumber } from '../../lib/format';
import type { ComputeSandbox } from '../../native/types';
import { computeTotals, machineMix, originKey, sizeMix, type OriginShare } from '../../services/compute';
import { machinesCpu } from '../../services/computePage';
import { useFleetHealthSelect } from '../../services/fleetHealth';
import { identityColorCss } from '../../services/identityColors';
import { machineLookKey, resolveMachineLook, useMachineLookChoices } from '../../services/machineLook';
import { SettingsSection } from '../layout/settings';
import { Meter } from '../ui/meter';

/**
 * Sizes take the chart colors in a fixed order; past four, the rest share one gray "Other" rather than a made-up hue.
 * Machines wear their own identity color, as everywhere in Arbor.
 */
const SIZE_COLORS = ['var(--chart-1)', 'var(--chart-5)', 'var(--chart-2)', 'var(--chart-4)'] as const;
const QUIET = 'var(--color-zinc-500)';

type Segment = { key: string; count: number; color: string; label: ReactNode; detail?: ReactNode };

/** One bar split by share, with a 2px gap between segments, and its legend under it. */
function SegmentedBar({ segments, label }: { segments: Segment[]; label: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
        {segments.map((segment) => (
          <span key={segment.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(segment.count / Math.max(1, total)) * 100}%`, background: segment.color }} />
        ))}
      </div>
      <ul className="flex flex-col gap-1.5 text-xs">
        {segments.map((segment) => (
          <li key={segment.key} className="flex min-w-0 items-center gap-2">
            <span className="size-2 shrink-0 rounded-[2px]" style={{ background: segment.color }} aria-hidden="true" />
            <span className="font-medium tabular-nums text-foreground">{segment.count}</span>
            <span className="min-w-0 truncate text-foreground/80">{segment.label}</span>
            {segment.detail ? <span className="truncate text-muted-foreground">{segment.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** By what started them: each machine in its own color, then not linked and teammates' in gray. */
function OriginBar({ sandboxes }: { sandboxes: readonly ComputeSandbox[] }) {
  const { t } = useI18n();
  const choices = useMachineLookChoices();
  const segments = machineMix(sandboxes).map((share: OriginShare): Segment => {
    const key = originKey(share.origin);
    if (share.origin.kind !== 'machine') {
      return { key, count: share.count, color: QUIET, label: t(share.origin.kind === 'teammate' ? 'compute.aTeammate' : 'compute.notLinked') };
    }
    const name = share.origin.machine;
    return { key, count: share.count, color: identityColorCss(resolveMachineLook(name, choices[machineLookKey(name)], null).color), label: name };
  });
  return <SegmentedBar segments={segments} label={t('compute.page.mix.byOrigin')} />;
}

function CpuRow({ label, busy, total }: { label: string; busy: number; total: number }) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-xs">
      <span className="truncate text-muted-foreground">{label}</span>
      <Meter value={total ? (busy / total) * 100 : null} tone="success" animated={false} />
      <span className="tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">{formatNumber(Math.round(busy))}</span> {t('compute.page.stat.of', { max: formatNumber(total) })}
      </span>
    </div>
  );
}

/**
 * What's running, three ways: by size, by what started it, and how much CPU is in use now across the sandboxes and,
 * from the health Arbor already reads for its machines (no reads of its own), across the machines and both together.
 */
export function ComputeMix({ sandboxes }: { sandboxes: readonly ComputeSandbox[] }) {
  const { t } = useI18n();
  const machines = useFleetHealthSelect(machinesCpu);
  const totals = computeTotals(sandboxes);
  if (!totals.running) return null;
  const sizes = sizeMix(sandboxes);
  const kept = sizes.slice(0, SIZE_COLORS.length);
  const rest = sizes.slice(SIZE_COLORS.length);
  const sizeSegments: Segment[] = kept.map((share, index) => ({
    key: share.size,
    count: share.count,
    color: SIZE_COLORS[index] ?? QUIET,
    label: share.size,
    detail: t('compute.sizeLine', { vcpus: share.vcpus, memory: formatNumber(share.memoryGb) }),
  }));
  if (rest.length) sizeSegments.push({ key: 'other', count: rest.reduce((sum, share) => sum + share.count, 0), color: QUIET, label: t('compute.page.mix.other') });

  return (
    <SettingsSection title={t('compute.page.mix.title')} contentClassName="@container">
      <div className="overflow-hidden">
        <div className="-mt-px -ml-px grid grid-cols-1 *:border-t *:border-l *:border-border/50 *:px-4 *:py-3 @min-[44rem]:grid-cols-3">
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">{t('compute.page.mix.bySize')}</span>
            <SegmentedBar segments={sizeSegments} label={t('compute.page.mix.bySize')} />
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">{t('compute.page.mix.byOrigin')}</span>
            <OriginBar sandboxes={sandboxes} />
          </div>
          <div className="flex flex-col gap-3">
            <span className="text-xs text-muted-foreground">{t('compute.page.mix.cpu')}</span>
            <div className="flex flex-col gap-2.5">
              <CpuRow label={t('compute.page.mix.sandboxes')} busy={totals.busyVcpus} total={totals.vcpus} />
              {machines ? (
                <>
                  <CpuRow label={t('compute.page.mix.machines')} busy={machines.busy} total={machines.cores} />
                  <CpuRow label={t('compute.page.mix.everything')} busy={totals.busyVcpus + machines.busy} total={totals.vcpus + machines.cores} />
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

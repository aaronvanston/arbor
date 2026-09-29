import { useMemo } from 'react';
import { useI18n } from '../i18n';
import { cn } from '../lib/utils';
import { sparklinePoints, type LimitSample } from '../services/limitsHistory';

const W = 100;
const H = 24;
const toneStroke = { success: 'text-success', warning: 'text-warning', error: 'text-error', muted: 'text-muted-foreground' } as const;

/** Last 24h of pooled percent-left for one provider; hidden until two samples span at least an hour. */
export function LimitSparkline({ samples, now, tone, className }: { samples: LimitSample[]; now: number; tone: keyof typeof toneStroke; className?: string }) {
  const { t } = useI18n();
  const points = useMemo(() => sparklinePoints(samples, now, W, H), [samples, now]);

  if (!points.length) return null;
  const pairs = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  const area = `M ${points[0]!.x.toFixed(1)},${H} L ${pairs.join(' L ')} L ${W},${H} Z`;
  return (
    <svg
      className={cn('h-6 w-24 shrink-0 overflow-visible', toneStroke[tone], className)}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t('accounts.sparkline.aria')}
    >
      <path d={area} fill="currentColor" opacity="0.12" />
      <polyline points={pairs.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

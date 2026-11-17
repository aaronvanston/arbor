import { useAnimatedNumber } from '../../hooks/useAnimatedNumber';
import { cn } from '../../lib/utils';
import type { StatusTone } from './status-dot';

/**
 * A reading as a thin bar toward 100%, in its tone: a machine's disk and swap, a sandbox's CPU and memory. It rolls to
 * a new reading; `animated={false}` sets it at once, for a long table whose rows all change in the same round.
 */
export function Meter({ value, tone, className, animated = true }: { value: number | null; tone: StatusTone; className?: string; animated?: boolean }) {
  // A tenth of a percent is under a pixel on any bar up to 1,000 px wide. A null target never starts a frame.
  const tweened = useAnimatedNumber(animated ? value : null, 0.1);
  const shown = animated ? tweened : value;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-input/50 dark:bg-input/70', className)} role="presentation">
      <div
        className={cn('h-full rounded-full', tone === 'error' ? 'bg-error' : tone === 'warning' ? 'bg-warning' : tone === 'muted' ? 'bg-muted-foreground/40' : 'bg-primary')}
        style={{ width: `${Math.max(0, Math.min(100, shown ?? 0))}%` }}
      />
    </div>
  );
}

import type * as React from 'react';
import { cn } from '../../lib/utils';

function Progress({
  value,
  className,
  tone = 'primary',
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & { value: number | null; tone?: 'primary' | 'success' | 'warning' | 'error' }) {
  const indeterminate = value === null || Number.isNaN(value);
  const percent = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-input/60 dark:bg-input', className)}
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(percent)}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-300',
          tone === 'primary' && 'bg-primary',
          tone === 'success' && 'bg-success',
          tone === 'warning' && 'bg-warning',
          tone === 'error' && 'bg-error',
          indeterminate && 'w-1/3 motion-safe:animate-pulse',
        )}
        style={indeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export { Progress };

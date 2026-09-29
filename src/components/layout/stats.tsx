import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function StatBlock({
  label,
  value,
  hint,
  tone = 'default',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 px-4 py-4', className)} data-slot="stat-block">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div
        className={cn(
          'mt-1 truncate text-xl font-medium tabular-nums text-foreground',
          tone === 'warning' && 'text-warning-foreground',
          tone === 'danger' && 'text-destructive-foreground',
          tone === 'success' && 'text-success-foreground',
        )}
      >
        {value}
      </div>
      {/* Two lines, so a breakdown like "OK 1,544 · Fail 63 · Canceled 6" survives a narrow column. */}
      {hint ? <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/**
 * How many columns a grid of `columns` blocks takes as the room it has grows, always dividing the blocks evenly so
 * no row is left half empty. It goes by the grid's own width, not the window's, so a hidden or wider sidebar counts.
 * Each step leaves every column room for the longest labels (about 130px, like "Value at API prices") and values:
 * six blocks go to three columns and four to two well before a label would be cut off.
 */
const STAT_COLUMNS: Record<2 | 3 | 4 | 6, string> = {
  2: 'grid-cols-1 @xs:grid-cols-2',
  3: 'grid-cols-1 @lg:grid-cols-3',
  4: 'grid-cols-1 @xs:grid-cols-2 @min-[44rem]:grid-cols-4',
  6: 'grid-cols-1 @xs:grid-cols-2 @lg:grid-cols-3 @min-[60rem]:grid-cols-6',
};

/**
 * Grid of StatBlocks with hairline dividers. Its blocks wrap onto more rows as it narrows, so every block draws the
 * line above and to its left, and the grid sits a pixel up and left inside a clipping frame that hides the ones on
 * the outer edge.
 */
export function StatsGrid({ children, columns = 4, className }: {
  children: ReactNode;
  /** The most columns the blocks spread to, which is usually how many there are. */
  columns?: 2 | 3 | 4 | 6;
  className?: string;
}) {
  return (
    <div
      className={cn('@container overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs/5', className)}
      data-slot="stats-grid"
    >
      <div className={cn('-mt-px -ml-px grid *:border-t *:border-l *:border-border/60', STAT_COLUMNS[columns])} data-slot="stats-grid-columns">
        {children}
      </div>
    </div>
  );
}

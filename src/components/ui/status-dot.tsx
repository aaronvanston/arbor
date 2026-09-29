import { cn } from '../../lib/utils';

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'muted' | 'primary';

const TONE_CLASS: Record<StatusTone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  info: 'bg-info',
  muted: 'bg-muted-foreground/50',
  primary: 'bg-primary',
};

export function StatusDot({ tone, pulse = false, className }: { tone: StatusTone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0 rounded-full', TONE_CLASS[tone], pulse && 'motion-safe:animate-status-pulse', className)} aria-hidden="true" />
  );
}

/** Pill with a status dot, used for runtime/quota/oauth state. */
export function StatusPill({ tone, children, className }: { tone: StatusTone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-6 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-foreground dark:bg-input/32', className)}>
      <StatusDot tone={tone} pulse={tone === 'warning' || tone === 'info'} />
      {children}
    </span>
  );
}

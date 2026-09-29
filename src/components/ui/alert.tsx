import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';
import { cn } from '../../lib/utils';

const alertVariants = cva('relative rounded-xl border px-3.5 py-3 text-sm text-card-foreground', {
  defaultVariants: { variant: 'default' },
  variants: {
    variant: {
      default: 'bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground',
      error: 'border-error/32 bg-error-surface text-error-foreground [&_[data-slot=alert-description]]:text-error-foreground [&_svg]:text-error',
      info: 'border-info/32 bg-info/4 [&_svg]:text-info',
      success: 'border-success/32 bg-success/4 [&_svg]:text-success',
      warning: 'border-warning/32 bg-warning-surface text-warning-foreground [&_[data-slot=alert-description]]:text-warning-foreground [&_svg]:text-warning',
    },
  },
});

function Alert({
  className,
  variant,
  icon,
  action,
  children,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants> & { icon?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn(alertVariants({ variant }), className)} data-slot="alert" role="alert" {...props}>
      <div className="flex items-start gap-2">
        {icon ? <div className="flex h-5 w-4 shrink-0 items-center justify-center [&>svg]:size-4">{icon}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
        {action ? <div className="flex shrink-0 items-center self-center">{action}</div> : null}
      </div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('font-medium leading-5', className)} data-slot="alert-title" {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2.5 text-muted-foreground', className)} data-slot="alert-description" {...props} />;
}

export { Alert, AlertTitle, AlertDescription, alertVariants };

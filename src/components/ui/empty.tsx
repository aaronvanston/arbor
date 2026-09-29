import type * as React from 'react';
import { cn } from '../../lib/utils';

// How much room an empty state takes: `sm` inside a card, among the card's rows; `default` when it's all a page or a
// tab has to show.
const EMPTY_SIZE_CLASS = {
  sm: 'gap-4 px-6 py-10',
  default: 'gap-5 px-8 py-12',
} as const;

function Empty({ className, size = 'default', ...props }: React.ComponentProps<'div'> & { size?: keyof typeof EMPTY_SIZE_CLASS }) {
  return (
    <div
      className={cn('flex min-w-0 flex-1 flex-col items-center justify-center text-balance text-center', EMPTY_SIZE_CLASS[size], className)}
      data-size={size}
      data-slot="empty"
      {...props}
    />
  );
}

const EMPTY_MEDIA_CLASS =
  "relative flex size-9 shrink-0 items-center justify-center rounded-md border bg-card not-dark:bg-clip-padding text-foreground shadow-sm/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)] [&_svg:not([class*='size-'])]:size-4.5 [&_svg]:text-muted-foreground";

function EmptyMedia({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div className={cn('relative mb-1', className)} data-slot="empty-media" {...props}>
      <div aria-hidden="true" className={cn(EMPTY_MEDIA_CLASS, '-translate-x-0.5 -rotate-10 pointer-events-none absolute bottom-px origin-bottom-left scale-84 shadow-none')} />
      <div aria-hidden="true" className={cn(EMPTY_MEDIA_CLASS, 'pointer-events-none absolute bottom-px origin-bottom-right translate-x-0.5 rotate-10 scale-84 shadow-none')} />
      <div className={EMPTY_MEDIA_CLASS}>{children}</div>
    </div>
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('text-base font-semibold', className)} data-slot="empty-title" {...props} />;
}

function EmptyDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('max-w-sm text-sm text-muted-foreground [[data-slot=empty-title]+&]:mt-1', className)} data-slot="empty-description" {...props} />;
}

function EmptyContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex w-full min-w-0 max-w-sm flex-col items-center gap-3 text-sm', className)} data-slot="empty-content" {...props} />;
}

export { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent };

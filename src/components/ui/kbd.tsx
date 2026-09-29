import type * as React from 'react';
import { cn } from '../../lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-sans text-xs font-medium text-muted-foreground dark:bg-input/48',
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

export { Kbd };

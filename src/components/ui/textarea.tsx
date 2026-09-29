import type * as React from 'react';
import { cn } from '../../lib/utils';

type TextareaProps = React.ComponentProps<'textarea'> & {
  wrapperClassName?: string;
  ref?: React.Ref<HTMLTextAreaElement>;
};

function Textarea({ className, wrapperClassName, ...props }: TextareaProps) {
  return (
    <span
      className={cn(
        'relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] dark:bg-input/32 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]',
        wrapperClassName,
      )}
      data-slot="textarea-control"
    >
      <textarea
        className={cn(
          'min-h-20 w-full resize-y rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] outline-none placeholder:text-placeholder',
          className,
        )}
        data-slot="textarea"
        {...props}
      />
    </span>
  );
}

export { Textarea, type TextareaProps };

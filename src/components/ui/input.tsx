import type * as React from 'react';
import { cn } from '../../lib/utils';

type InputProps = Omit<React.ComponentProps<'input'>, 'size'> & {
  size?: 'sm' | 'default' | 'lg';
  /** Monospace with even-width digits, for paths, hosts, commands, keys and numbers. */
  font?: 'default' | 'mono';
  wrapperClassName?: string;
  startAddon?: React.ReactNode;
  endAddon?: React.ReactNode;
  ref?: React.Ref<HTMLInputElement>;
};

const INPUT_WRAPPER_CLASS =
  'relative inline-flex w-full items-center rounded-lg border border-input bg-background not-dark:bg-clip-padding text-sm text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]';

function Input({ className, wrapperClassName, size = 'default', font = 'default', startAddon, endAddon, ...props }: InputProps) {
  return (
    <span className={cn(INPUT_WRAPPER_CLASS, wrapperClassName)} data-size={size} data-slot="input-control">
      {startAddon ? (
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-2.5 text-icon-muted [&_svg:not([class*='size-'])]:size-4">
          {startAddon}
        </span>
      ) : null}
      <input
        className={cn(
          'h-7.5 w-full min-w-0 rounded-[inherit] bg-transparent px-[calc(--spacing(3)-1px)] leading-7.5 outline-none placeholder:text-placeholder disabled:cursor-not-allowed [transition:background-color_5000000s_ease-in-out_0s]',
          size === 'sm' && 'h-6.5 px-[calc(--spacing(2.5)-1px)] text-xs leading-6.5',
          size === 'lg' && 'h-8.5 leading-8.5',
          startAddon && 'ps-8',
          endAddon && 'pe-8',
          props.type === 'search' && '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none',
          font === 'mono' && 'tabular-nums',
          className,
        )}
        data-slot="input"
        {...props}
      />
      {endAddon ? (
        <span className="absolute inset-y-0 end-0 flex items-center pe-1 [&_svg:not([class*='size-'])]:size-4">
          {endAddon}
        </span>
      ) : null}
    </span>
  );
}

export { Input, INPUT_WRAPPER_CLASS, type InputProps };
